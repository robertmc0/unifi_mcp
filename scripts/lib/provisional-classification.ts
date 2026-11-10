/**
 * PROVISIONAL Phase 0 risk/sensitivity proposals for the API coverage inventory.
 *
 * These are planning aids only. They are NOT the reviewed security metadata required by
 * spec §4.3: that lives with each adapter (packages/unifi-<app>) from Phase 2 onward,
 * is reviewed in code, and is never derived from vendor documents. Nothing here enables
 * an operation. Classes follow spec §6.3; unknowns default to the more restrictive tier.
 */
import type { ApplicationId, InventoryOperation } from './api-specs.ts';

export type Effect = 'read' | 'write';
export type Risk = 'low' | 'medium' | 'high';
export type SensitivityTag =
  | 'personal_identifier'
  | 'network_identity'
  | 'camera_image'
  | 'recording'
  | 'access_log'
  | 'credential'
  | 'location'
  | 'biometric_or_access_identity';

export interface ProvisionalClassification {
  effect: Effect;
  risk: Risk;
  sensitivity: SensitivityTag[];
  /** Proposed to stay disabled even when writes are granted (irreversible / out-of-band effects). */
  defaultDisabled: boolean;
  rationale: string;
}

interface Rule {
  match: RegExp;
  risk?: Risk;
  effect?: Effect;
  sensitivity?: SensitivityTag[];
  defaultDisabled?: boolean;
  rationale: string;
}

// Rules are evaluated against "<METHOD> <path>"; the first matching rule wins.
const NETWORK_RULES: Rule[] = [
  {
    match: /^GET .*\/clients/,
    sensitivity: ['personal_identifier', 'network_identity'],
    rationale: 'Client identities, addresses and usage.',
  },
  {
    match: /^GET .*\/hotspot\/vouchers/,
    sensitivity: ['credential'],
    rationale: 'Voucher `code` is a network-access credential.',
  },
  {
    match: /^GET .*\/wifi\/broadcasts/,
    sensitivity: ['credential'],
    rationale: 'Schema includes a WPA `passphrase` field.',
  },
  {
    match: /^GET .*\/(pending-devices|devices|wans|vpn\/|radius\/)/,
    sensitivity: ['network_identity'],
    rationale: 'Infrastructure addressing/topology.',
  },
  { match: /^GET /, rationale: 'Operational metadata read.' },
  {
    match: /^POST .*\/clients\/\{clientId\}\/actions$/,
    risk: 'medium',
    rationale: 'Documented actions: AUTHORIZE_/UNAUTHORIZE_GUEST_ACCESS.',
  },
  {
    match: /^POST .*\/devices\/\{deviceId\}\/actions$/,
    risk: 'high',
    rationale: 'Documented action RESTART (device/gateway reboot).',
  },
  {
    match: /^POST .*\/ports\/\{portIdx\}\/actions$/,
    risk: 'high',
    rationale: 'Documented action POWER_CYCLE (PoE outage on attached device).',
  },
  {
    match: /^(POST|DELETE) \/v1\/sites\/\{siteId\}\/devices/,
    risk: 'high',
    rationale: 'Device adoption/removal.',
  },
  {
    match: /^(POST|PUT) .*\/wifi\/broadcasts/,
    risk: 'medium',
    sensitivity: ['credential'],
    rationale:
      'Wi-Fi change; elevate to high when security mode is weakened. Body carries passphrase.',
  },
  {
    match: /^DELETE .*\/wifi\/broadcasts/,
    risk: 'high',
    rationale: 'Removes an SSID and disconnects its clients.',
  },
  {
    match: /^POST .*\/hotspot\/vouchers/,
    risk: 'medium',
    sensitivity: ['credential'],
    rationale: 'Creates guest network-access credentials (returned in response).',
  },
  { match: /^DELETE .*\/hotspot\/vouchers/, risk: 'medium', rationale: 'Revokes guest access.' },
  {
    match: /\/(networks|firewall|acl-rules|dns\/policies|traffic-matching-lists)/,
    risk: 'high',
    rationale: 'Routing/VLAN/firewall/DNS policy change (spec §6.3 high).',
  },
];

const PROTECT_RULES: Rule[] = [
  {
    match: /^GET .*\/snapshot$/,
    sensitivity: ['camera_image'],
    rationale: 'Returns a camera image.',
  },
  {
    match: /^GET .*\/rtsps-stream$/,
    sensitivity: ['credential', 'recording'],
    rationale: 'Returns live-stream URLs that grant video access.',
  },
  {
    match: /^GET \/v1\/subscribe\/events$/,
    sensitivity: ['personal_identifier'],
    rationale: 'Event stream (detections, doorbell, etc.).',
  },
  {
    match: /^GET \/v1\/(users|ulp-users)/,
    sensitivity: ['personal_identifier'],
    rationale: 'User identities and e-mail.',
  },
  { match: /^GET /, sensitivity: ['network_identity'], rationale: 'Device metadata incl. MAC/IP.' },
  {
    match: /\/disable-mic-permanently$/,
    risk: 'high',
    defaultDisabled: true,
    rationale: 'Irreversible (spec §6.3 example).',
  },
  {
    match: /\/talkback-session$/,
    risk: 'high',
    sensitivity: ['credential'],
    rationale: 'Opens audio into premises; returns session URL.',
  },
  {
    match: /^POST .*\/rtsps-stream$/,
    risk: 'high',
    sensitivity: ['credential', 'recording'],
    rationale: 'Creates live-video access streams.',
  },
  {
    match: /^DELETE .*\/rtsps-stream$/,
    risk: 'medium',
    rationale: 'Breaks consumers of existing streams.',
  },
  {
    match: /\/arm-profiles/,
    risk: 'high',
    rationale: 'Arms/disarms or reconfigures alarm (security function).',
  },
  { match: /\/sirens\/\{id\}\/play$/, risk: 'high', rationale: 'Physical alarm actuation.' },
  {
    match: /\/(sirens|speakers)\/\{id\}\/(stop|test-sound)$/,
    risk: 'medium',
    rationale: 'Audible device action.',
  },
  {
    match: /\/relays\/\{id\}\/outputs\/.*\/activate$/,
    risk: 'high',
    rationale: 'Physical relay actuation (may drive doors/gates).',
  },
  {
    match: /\/alarm-hubs\/\{id\}\/outputs\/.*\/trigger$/,
    risk: 'high',
    rationale: 'Physical alarm output.',
  },
  {
    match: /\/alarm-manager\/webhook\//,
    risk: 'high',
    rationale: 'Triggers Alarm Manager automations of unknown scope.',
  },
  { match: /\/ptz\//, risk: 'medium', rationale: 'Moves camera field of view.' },
  {
    match: /^PATCH \/v1\/cameras\//,
    risk: 'high',
    rationale: 'Camera settings can disable recording/detection (security function).',
  },
  {
    match: /^(POST|PATCH) \/v1\/(liveviews|viewers)/,
    risk: 'low',
    rationale: 'Viewer/live-view layout.',
  },
  { match: /^PATCH /, risk: 'medium', rationale: 'Device setting change.' },
  {
    match: /^POST \/v1\/(files|pos)\//,
    risk: 'medium',
    rationale: 'Uploads/ingests data into Protect.',
  },
];

const ACCESS_RULES: Rule[] = [
  {
    match: /^POST .*\/credentials\/touch_passes$/,
    risk: 'high',
    defaultDisabled: true,
    rationale: 'Purchases Touch Passes (financial transaction).',
  },
  {
    match: /\/api_server\/certificates$/,
    risk: 'high',
    defaultDisabled: true,
    rationale: 'Replaces/removes the API listener certificate (trust anchor).',
  },
  {
    match: /^(POST|PUT|DELETE) .*\/webhooks\/endpoints/,
    risk: 'high',
    defaultDisabled: true,
    rationale: 'Makes the console send events to arbitrary URLs (exfiltration path).',
  },
  {
    match: /\/doors\/\{id\}\/unlock$/,
    risk: 'high',
    rationale: 'Physical unlock (spec §6.3: high regardless of verb).',
  },
  {
    match: /\/doors\/(\{id\}\/lock_rule|settings\/emergency)$/,
    rationale: 'Door lock rule / emergency status (physical access state).',
  },
  {
    match: /\/system\/(logs|static)/,
    sensitivity: ['access_log', 'personal_identifier'],
    rationale: 'Door access history.',
  },
  {
    match: /\/devices\/notifications$/,
    sensitivity: ['access_log', 'personal_identifier'],
    rationale: 'WebSocket door/doorbell event stream.',
  },
  {
    match: /\/credentials\//,
    sensitivity: ['credential', 'biometric_or_access_identity'],
    rationale: 'PIN/NFC/QR/Touch Pass access credentials.',
  },
  {
    match: /\/(pin_codes|nfc_cards|qr_codes|touch_passes|license_plates)/,
    sensitivity: ['credential', 'biometric_or_access_identity'],
    rationale: 'Assigns/removes access credentials.',
  },
  {
    match: /\/(access_policies|schedules|holiday_groups|door_groups|identity\/assignments)/,
    sensitivity: ['personal_identifier'],
    rationale: 'Changes who can open which doors, when.',
  },
  { match: /^POST .*\/doorbell$/, risk: 'medium', rationale: 'Rings a doorbell.' },
  {
    match: /\/(users|user_groups|visitors)/,
    sensitivity: ['personal_identifier'],
    rationale: 'Person records.',
  },
  { match: /\/(devices|doors)/, rationale: 'Access hardware.' },
];

const RULES: Record<ApplicationId, Rule[]> = {
  network: NETWORK_RULES,
  protect: PROTECT_RULES,
  access: ACCESS_RULES,
};

function effectOf(app: ApplicationId, op: InventoryOperation): Effect {
  // Access publishes a permission key per operation: view:* is a read even when POST is used.
  if (app === 'access' && op.vendorPermission !== undefined) {
    return op.vendorPermission.startsWith('view:') ? 'read' : 'write';
  }
  return op.method === 'GET' ? 'read' : 'write';
}

export function classifyProvisionally(
  app: ApplicationId,
  op: InventoryOperation,
): ProvisionalClassification {
  const rule = RULES[app].find((r) => r.match.test(op.key));
  const effect = rule?.effect ?? effectOf(app, op);
  // Unknown writes default to high; Access writes default to high (physical-access domain).
  const risk: Risk = effect === 'read' ? 'low' : (rule?.risk ?? 'high');
  return {
    effect,
    risk,
    sensitivity: rule?.sensitivity ?? [],
    defaultDisabled: rule?.defaultDisabled ?? false,
    rationale:
      rule?.rationale ?? (effect === 'write' ? 'Unclassified write: defaults to high.' : 'Read.'),
  };
}
