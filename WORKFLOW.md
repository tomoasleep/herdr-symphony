---
tracker:
  kind: github_project
  github_project:
    owner: "@me"
    number: 4
    repository: '{{ issue.fields["Repository"] }}'

polling:
  interval_ms: 30000

agent:
  max_concurrent_agents: 10
  max_retry_backoff_ms: 300000

work:
  active_states: [Ready]
  running_state: "In progress"
  success_state: "In review"
  failure_state: "Blocked"
  reporter: [file, tracker]

  workspace:
    provider: gwq
    branch: '{{ issue.fields["Branch"] | default: "herdr/" | append: issue.identifier | replace: "/", "_" }}'
    gwq:
      command: gwq
      create_branch: true

  runner: herdr_agent
  herdr_agent:
    agent: opencode
    opencode:
      model: '{{ issue.fields["Model"] | default: "openai/gpt-5.4" }}'
      agent: '{{ issue.fields["Agent"] | default: "build" }}'
    workspace_label: '{{ issue.identifier | replace: "/", "_" }}'
    turn_timeout_ms: 3600000
---

Issue を解決してください。
