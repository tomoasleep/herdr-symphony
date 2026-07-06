# E2E Test Rules

E2E assertions must use snapshot matchers such as `toMatchInlineSnapshot` or `toMatchSnapshot`.

Do not use `toContain` in `src/e2e` tests.

When verifying a screen, snapshot the whole captured screen. Do not filter the screen down to selected lines before asserting it.
