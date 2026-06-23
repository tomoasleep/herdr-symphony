export class WorkflowError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export const ErrorCode = {
  MISSING_WORKFLOW_FILE: "missing_workflow_file",
  WORKFLOW_PARSE_ERROR: "workflow_parse_error",
  WORKFLOW_FRONT_MATTER_NOT_A_MAP: "workflow_front_matter_not_a_map",
  INVALID_FRONT_MATTER: "invalid_front_matter",
  TEMPLATE_RENDER_ERROR: "template_render_error",
  LEGACY_CODEX_CONFIG: "legacy_codex_config",
  MISSING_TRACKER_KIND: "missing_tracker_kind",
  MISSING_TRACKER_OWNER: "missing_tracker_owner",
  MISSING_TRACKER_NUMBER: "missing_tracker_number",
  MISSING_TRACKER_BASE_DIR: "missing_tracker_base_dir",
  MISSING_TRACKER_CRON: "missing_tracker_cron",
  UNSUPPORTED_TRACKER_KIND: "unsupported_tracker_kind",
  UNSUPPORTED_WORKSPACE_PROVIDER: "unsupported_workspace_provider",
} as const
