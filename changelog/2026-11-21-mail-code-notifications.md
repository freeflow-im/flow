# Mail: desktop notifications of sign-in codes

- `[server]` A code found while prefetching new mail (before it is opened) is kept as a code alert (`mail_code_alerts`, 1 h), served by `GET …/code-alerts?since=`; per-account `codeAlerts` setting, on by default.
- `[web]` `[desktop]` Mail polls the alerts every 30 s, also while hidden, and shows each code once across tabs as a desktop notification; clicking it copies the code and opens the message. New "Notify me of sign-in codes" checkbox in Account settings.

## Feature

- **Sign-in codes as desktop notifications.** When new mail brings a sign-in or verification code, Mail shows the code in a desktop notification, so you don't have to open the message. Click it to copy the code and open the email. Turn it off per account in Account settings. It needs desktop notifications on in Flow and an OpenAI key in your organization's assistant settings.
