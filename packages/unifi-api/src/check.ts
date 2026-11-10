/**
 * Console connection check for `unifi-mcp console check` and `doctor` (ADR 0012).
 *
 * It resolves the address through the egress guard and opens a TLS connection with the
 * configured trust. It never sends an HTTP request, so the credential is never used. When
 * verification fails it connects once more without verification only to read the presented
 * certificate, so the operator can compare its pin with the console and decide to pin it.
 */
import { isIP } from 'node:net';
import { connect } from 'node:tls';
import type { ConsoleRegistry } from './consoles.ts';
import { EgressError, type EgressGuard } from './egress.ts';
import { isModuleId, type ModuleId } from './modules.ts';
import { connectTls, spkiSha256, TransportError } from './transport.ts';

export interface ConsoleCheck {
  consoleId: string;
  moduleId: ModuleId;
  host: string;
  port: number;
  address?: string;
  tlsMode: 'verify' | 'pinned' | 'insecure';
  reachable: boolean;
  /** True when the configured trust accepted the certificate (false for insecure mode). */
  verified: boolean;
  hasCredential: boolean;
  /** Presented certificate, when a TLS handshake completed. */
  certificate?: {
    pin: string;
    subject: string;
    issuer: string;
    validTo: string;
    selfSigned: boolean;
  };
  problem?: string;
}

async function presentedCertificate(
  address: string,
  port: number,
  host: string,
  timeoutMs: number,
) {
  return new Promise<ConsoleCheck['certificate']>((resolve) => {
    const socket = connect({
      host: address,
      port,
      ...(isIP(host) === 0 ? { servername: host } : {}),
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const certificate = socket.getPeerX509Certificate();
      socket.destroy();
      resolve(
        certificate === undefined
          ? undefined
          : {
              pin: `sha256/${spkiSha256(certificate)}`,
              subject: certificate.subject.replace(/\n/g, ', '),
              issuer: certificate.issuer.replace(/\n/g, ', '),
              validTo: new Date(certificate.validTo).toISOString(),
              selfSigned: certificate.subject === certificate.issuer,
            },
      );
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

export async function checkConsoleConnection(
  consoles: ConsoleRegistry,
  egress: EgressGuard,
  consoleId: string,
  moduleId: string,
  timeoutMs = 5000,
): Promise<ConsoleCheck | undefined> {
  if (!isModuleId(moduleId)) return undefined;
  let connection;
  try {
    connection = consoles.connection(consoleId, moduleId);
  } catch {
    connection = undefined;
  }
  if (connection === undefined) return undefined;
  const result: ConsoleCheck = {
    consoleId,
    moduleId,
    host: connection.host,
    port: connection.port,
    tlsMode: connection.trust.mode,
    reachable: false,
    verified: false,
    hasCredential: connection.credential !== undefined,
  };
  let address: string;
  try {
    address = (await egress.resolve(connection.host)).address;
    result.address = address;
  } catch (error) {
    result.problem =
      error instanceof EgressError ? error.message : 'The host could not be resolved.';
    return result;
  }
  try {
    const socket = await connectTls({
      address,
      port: connection.port,
      host: connection.host,
      trust: connection.trust,
      timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
    });
    socket.destroy();
    result.reachable = true;
    result.verified = connection.trust.mode !== 'insecure';
  } catch (error) {
    result.problem = error instanceof TransportError ? error.message : 'The connection failed.';
    result.reachable = !(error instanceof TransportError) || error.code.startsWith('tls_');
  }
  const certificate = await presentedCertificate(
    address,
    connection.port,
    connection.host,
    timeoutMs,
  );
  if (certificate !== undefined) {
    result.certificate = certificate;
    result.reachable = true;
  }
  return result;
}
