/**
 * @unifi-local-mcp/admin-ui
 *
 * Server-rendered pages and the stylesheet of the optional admin web interface (spec §13.1;
 * ADR 0016). No client-side JavaScript; served by @unifi-local-mcp/admin-api.
 */
export { escapeHtml, html, SafeHtml } from './html.ts';
export {
  accountPage,
  approvalPage,
  approvalsPage,
  auditPage,
  dashboardPage,
  errorPage,
  loginPage,
  type AccountView,
  type ApprovalDetail,
  type ApprovalRow,
  type AuditFilters,
  type AuditRow,
  type CheckView,
  type ConsoleSummary,
  type DashboardView,
  type Frame,
} from './pages.ts';
export {
  clientPage,
  clientsPage,
  consolePage,
  consolesPage,
  policyPage,
  settingsPage,
  type ClientDetail,
  type ClientRow,
  type ConsoleDetail,
  type ConsoleModuleDetail,
  type ConsoleRow,
  type EffectiveOperation,
  type PolicyView,
  type SettingsView,
} from './pages-manage.ts';
export { ADMIN_CSS } from './style.ts';
