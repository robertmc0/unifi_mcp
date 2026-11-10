/**
 * @unifi-local-mcp/approvals
 *
 * The human approval workflow for high-risk operations (spec §6.5; ADR 0011): proposals
 * bound to client, target, argument digest and policy version; approval only by an
 * administrator or the local CLI; single-use, time-limited resumption by the original
 * client through the dispatcher.
 */
export {
  APPROVAL_STATUSES,
  ApprovalError,
  ApprovalService,
  DEFAULT_APPROVAL_TTL,
  DEFAULT_RECENT_AUTH_MS,
  type ApprovalErrorCode,
  type ApprovalServiceOptions,
  type ApprovalStatus,
  type ApprovalTtl,
  type ApprovalView,
  type Approver,
  type ClientApprovalStatus,
} from './service.ts';
