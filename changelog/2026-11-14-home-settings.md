# Profile and settings move to Home's Settings page

- `[web]` Home has a Settings page (`/home/settings`, `/home/settings/notifications`) with the profile, notification prefs and privacy mode; every app's account menu "My profile"/"Settings" opens it (`intent.settings`).
- `[web]` The form is one shared component (`@flow/suite-bar/account-settings`); Chat's dialog renders it only where Home isn't reachable (desktop shell, an organization on another server). `/chat/?open=profile` redirects.
- `[web]` `[desktop]` Chat re-reads `/v1/me` on its own `user.updated`, so prefs changed elsewhere take effect without a reload.

## Feature

- **Settings live in Home.** Your profile, notifications and privacy mode are now one Settings page in Home, with a Settings entry in Home's sidebar. "My profile" and "Settings" in any app's account menu take you straight there.
