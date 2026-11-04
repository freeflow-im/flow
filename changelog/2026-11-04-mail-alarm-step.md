# Mail: the alarm records its step

- `[server]` The prefetch cache's alarm writes where it is (`mail_state.alarm_step`: the folder and step, or the message being parsed) before each step, and `GET …/debug/cache` answers it as `alarmStep`, so a run the runtime cut short (CPU limit) still says where it was.
