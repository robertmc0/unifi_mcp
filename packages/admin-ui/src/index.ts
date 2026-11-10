/**
 * @unifi-local-mcp/admin-ui
 *
 * Server-rendered pages and the stylesheet of the optional admin web interface (spec §13.1;
 * ADR 0016). No client-side JavaScript; served by @unifi-local-mcp/admin-api.
 */
export { escapeHtml, html, SafeHtml } from './html.ts';
export {
  approvalPage,
  approvalsPage,
  auditPage,
  dashboardPage,
  errorPage,
  loginPage,
  type ApprovalDetail,
  type ApprovalRow,
  type AuditFilters,
  type AuditRow,
  type CheckView,
  type ConsoleSummary,
  type DashboardView,
  type Frame,
} from './pages.ts';
export { ADMIN_CSS } from './style.ts';
