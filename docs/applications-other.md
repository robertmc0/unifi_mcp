# Other UniFi applications

> **Status: no adapter.** This service works with UniFi Network, UniFi Protect and UniFi
> Access. For every other application it reports a status and a reason, and does nothing
> else ([ADR 0024](adr/0024-other-applications-as-disabled-slots.md)). The reasons were
> last checked against Ubiquiti's publications on 2026-11-15.

The service uses only **official local** APIs that Ubiquiti publishes
([ADR 0005](adr/0005-official-local-unifi-api-contracts.md)). An application without such
an API cannot be supported, whatever its own web interface or a community project uses.

## What is reported

| Module id    | Application   | Status                                           |
| ------------ | ------------- | ------------------------------------------------ |
| `talk`       | UniFi Talk    | `unavailable: official_local_api_not_documented` |
| `connect`    | UniFi Connect | `unavailable: official_local_api_not_documented` |
| `drive`      | UniFi Drive   | `unavailable: official_local_api_not_documented` |
| `innerspace` | InnerSpace    | `unavailable: adapter_not_implemented`           |

| Reason                              | Meaning                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `official_local_api_not_documented` | No official local API for the application was found on Ubiquiti's developer portal or in its help centre. |
| `adapter_not_implemented`           | Ubiquiti publishes an official API with a local server, but this project has no adapter for it.           |

"Not found" is the result of a check on a date, not a statement by Ubiquiti. If you know
of an official local API that is missing here, see [Adding an application](#adding-an-application).

Site Manager, Mobility and Carrier Fabric are not in the table. Their official APIs are
cloud-only (`api.ui.com`), and this service never calls the cloud.

## Where you see it

On the host:

```sh
unifi-mcp api modules
```

```text
MODULE      STATUS                                          CONTRACT        OPERATIONS  EVENT STREAMS
network     supported                                       11.0.97         73          0
protect     supported                                       7.3.74, 7.4.96  79          2
access      supported                                       2026-03-23      97          1
talk        unavailable: official_local_api_not_documented  -               0           0
connect     unavailable: official_local_api_not_documented  -               0           0
drive       unavailable: official_local_api_not_documented  -               0           0
innerspace  unavailable: adapter_not_implemented            -               0           0
```

`OPERATIONS` counts the operations the service registers for a module, over all its
contract revisions. [API coverage](api-coverage/README.md) compares them with each
revision.

For an MCP client:

- `unifi_list_modules` lists the three modules with `"status": "supported"` and the four
  applications above with `"status": "unavailable"`, a `reason`, and no operations. Every
  client sees the same four entries. They say nothing about your consoles.
- `unifi_list_operations` with `moduleId` set to one of them returns an empty list and
  `"module": { "moduleId": "talk", "status": "unavailable", "reason": "…" }`.
- No operation exists for them. `unifi_describe_operation` and `unifi_execute` answer an
  id such as `talk.info.get` like any other unknown operation.

## What you cannot do

An unavailable application has no credential, port, version or policy entry, so there is
nothing to configure:

| You try                                                           | Result                                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--module talk` on `console enable-module`, `set-credential`, …   | Exit 2: `--module talk is unavailable: official_local_api_not_documented. …`                                           |
| A console policy with `modules: { talk: … }`                      | Refused: `Modules without an adapter cannot be configured: talk (unavailable: official_local_api_not_documented).`     |
| A bootstrap file with `modules: { talk: … }` under a console      | Refused: `consoles.0.modules: talk is unavailable: official_local_api_not_documented`. Nothing in the file is applied. |
| A client permission such as `talk.*.read` in a client policy      | Accepted, and grants nothing: no operation has that permission.                                                        |
| Any other name, for example `--module teleport` or a typing error | `--module must be network, protect or access.` or `Unknown modules: teleport.`                                         |

The service never sends a request about these applications to a console.

## Adding an application

An adapter can be added only for an official local API with a published contract
(AGENTS.md, "UniFi API rules"). Reverse-engineered, private or cloud endpoints are not
accepted. The steps, recorded in ADR 0024:

1. Evidence: the vendor's contract (source URL, version, local base URL, authentication)
   in a new ADR.
2. The artefacts under `api-specs/<application>/<revision>/`, with checksums
   ([api-specs/README.md](../api-specs/README.md)).
3. The module, its endpoint and its credential kind, from that provenance.
4. Generated schemas and security metadata reviewed by a person, operation by operation.
5. Mock tests, negative tests, the coverage matrix and an operator guide like the ones
   for [Network](applications-network.md), [Protect](applications-protect.md) and
   [Access](applications-access.md).

InnerSpace already has the first requirement: a published API of six reads with a local
server (ADR 0005). No adapter is planned. It is listed so that its status is true.
