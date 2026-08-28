# G5 temporary sensitive runtime ACL acceptance — PROPOSED / EXPLICIT OWNER APPROVAL REQUIRED

Status: proposed, not accepted
Owner: Vyacheslav Zakharov
Candidate application SHA: `718c04a56dd997147b49a5c9c8161b9265a5ef71`
Target role: `gbrain_runtime NOBYPASSRLS`
Production authorization: none

## Decision requested

Approve a temporary compatibility boundary for the first role-separation transition:

1. one `gbrain_runtime` command-union role preserves the currently shared service principal topology;
2. fifteen sensitive tables receive only the commands listed below;
3. command-specific RLS policies use `true` expressions to preserve existing row behavior and are **not row isolation**;
4. runtime receives no ownership, role membership, DDL, database/schema CREATE, TRIGGER, TRUNCATE, REFERENCES, grant option or sequence UPDATE/setval;
5. destructive trusted-CLI `oauth_clients DELETE` is excluded from runtime and requires a separately governed admin path;
6. `migration_impact_log SELECT` is retained only for read-only `gbrain onboard --history` compatibility;
7. all temporary sensitive grants expire at the earlier of **30 calendar days after production ACL cutover** or **2026-10-01 00:00 +05**;
8. before expiry, each temporary boundary must be replaced by a reviewed hardened routine/key-scoped interface, split service role, or documented feature exclusion; otherwise production writers must remain on HOLD at expiry rather than silently extending access.

## Temporary sensitive commands

| Table | Commands |
|---|---|
| `access_tokens` | SELECT, INSERT, UPDATE |
| `config` | SELECT, INSERT, UPDATE, DELETE |
| `mcp_request_log` | SELECT, INSERT |
| `oauth_clients` | SELECT, INSERT, UPDATE |
| `oauth_codes` | SELECT, INSERT, DELETE |
| `oauth_tokens` | SELECT, INSERT, DELETE |
| `portal_users` | SELECT, INSERT, UPDATE |
| `portal_source_grants` | SELECT, INSERT, UPDATE, DELETE |
| `portal_access_requests` | SELECT, INSERT, UPDATE |
| `portal_access_request_grants` | SELECT, INSERT, UPDATE |
| `portal_acl_audit` | SELECT, INSERT |
| `source_connector_configs` | SELECT, INSERT, UPDATE |
| `source_connector_secret_audit` | SELECT, INSERT |
| `source_connector_secrets` | SELECT, INSERT, UPDATE, DELETE |
| `source_connectors` | SELECT, INSERT, UPDATE, DELETE |

## Explicitly accepted residual risks

- A single union role gives every holder the combined command privileges needed by persistent HTTP/MCP, worker, ingest and read-only trusted CLI reporting paths.
- Role-scoped permissive compatibility policies prevent NOBYPASSRLS from breaking current behavior but do not filter rows.
- Direct `config` CRUD cannot distinguish operational checkpoints from security/policy key namespaces.
- Direct Portal DML relies on application transactions/triggers rather than a database routine boundary.
- Direct OAuth/token DML exposes verifier and authorization state to the shared runtime role.
- Direct connector-secret CRUD allows the connector execution process to receive decrypted credentials and allows management paths to mutate encrypted records; table ACL cannot isolate the secret consumer from the secret value.
- Application audit coupling remains partly application-enforced until hardened routines are deployed.

## Mandatory hardening milestones

1. Key-scoped `config` interface separating operational checkpoints from security/credential policy keys.
2. Portal authority routines for provision, grants, requests, decisions and append-only audit in one transaction.
3. Connector secret get-status/get-runtime-secret/rotate/delete routines with atomic audit and connector-specific execution identity.
4. OAuth/token routines for issuance, verification/touch, rotation, revocation and client administration.
5. Service-role split assessment using observed persistent/worker/ingest DB sessions.
6. Hosted PostgreSQL positive/negative tests for every allowed/denied command, RLS policy, trigger invariant and rollback.

## Non-authorization

Approval of this risk package does **not** authorize production mutation. Production still requires exact forward/inverse SQL, hosted PostgreSQL 16 validation, HBA/ident and launcher package, backup/rollback proof, independent exact reviews, and a separate literal artifact-bound ACL GO.

## Approval format

Approve only by explicitly accepting this complete package and its expiry, for example:

`APPROVE G5 temporary sensitive runtime ACL package, owner Vyacheslav Zakharov, expiry earlier of cutover+30 days or 2026-10-01 00:00 +05.`
