// The person's profile and settings (docs/specs/home.md §2.2): the one form for both, drawn as Home's Settings page and,
// where Home cannot be reached (the desktop shell, an organization on another server), in Chat's dialog. Each host
// passes its own way to the server (Home its session cookie, Chat the connection's bearer) and is told of every save,
// so its suite bar's name and picture follow at once.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PROFILE_BIO_MAX, PROFILE_TITLE_MAX, PROFILE_WEBSITE_MAX, isProfileWebsiteUrl, type NotificationPrefs, type UserDTO } from '@flow/shared';
import type { SettingsSection } from '@flow/shared/addresses';
import './account-settings.css';

/** What a profile save sends (`PATCH /v1/me`). */
export interface ProfilePatch {
  displayName?: string;
  title?: string;
  timezone?: string;
  website?: string;
  bio?: string;
  notificationPrefs?: Partial<NotificationPrefs>;
  privacyMode?: boolean;
}

/** The host's way to the server for the signed-in person. Each call answers with the person as saved. */
export interface AccountSettingsApi {
  patchMe(patch: ProfilePatch): Promise<UserDTO>;
  uploadAvatar(file: File): Promise<UserDTO>;
  deleteAccount(): Promise<void>;
}

export interface AccountSettingsProps {
  user: UserDTO;
  /** Which parts to draw, in order: Home draws one at a time (its tabs), Chat's dialog both. */
  sections: readonly SettingsSection[];
  /** The part to bring into view first (Chat's dialog, opened from the menu's Settings row). */
  focus?: SettingsSection;
  api: AccountSettingsApi;
  /** The picture to draw, as an address the host can show (Chat fetches it with its bearer). */
  avatarSrc: string | null;
  /** The caller's own address in the organization shown (platform.md §3.2), when there is one. */
  address?: string | null;
  /** The server the account is on, named in the deletion warning. */
  serverOrigin: string;
  /** Whether "Keep banners on screen" is offered: in the desktop shell how long a banner stays is the OS's. */
  persistentBanners: boolean;
  /** The person as saved, after every change: the host keeps it and refreshes what shows the person. */
  onUser(user: UserDTO): void;
  /** After the profile's Save: Chat's dialog closes; Home's page says it was saved. */
  onProfileSaved?(): void;
  /** A Cancel beside Save (Chat's dialog); none on a page. */
  onCancel?(): void;
  /** The account is gone: the host signs out. */
  onDeleted(): void;
}

const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

export function AccountSettings(props: AccountSettingsProps) {
  const { user, api } = props;
  const [error, setError] = useState<string | null>(null);
  const notificationsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (props.focus === 'notifications') notificationsRef.current?.scrollIntoView?.({ block: 'start' });
  }, [props.focus]);

  return (
    <div className="as-root" data-testid="account-settings">
      {props.sections.map((s) =>
        s === 'profile' ? (
          <ProfileSection key={s} {...props} setError={setError} />
        ) : (
          <section key={s} ref={notificationsRef} className="as-section" data-testid="account-settings-notifications">
            <NotificationsSection {...props} api={api} user={user} setError={setError} />
          </section>
        ),
      )}
      {error && (
        <p className="as-error" role="alert" data-testid="account-settings-error">
          {error}
        </p>
      )}
    </div>
  );
}

function ProfileSection(props: AccountSettingsProps & { setError(e: string | null): void }) {
  const { user, api, setError } = props;
  const [displayName, setDisplayName] = useState(user.displayName);
  const [title, setTitle] = useState(user.title ?? '');
  const [timezone, setTimezone] = useState(user.timezone || 'UTC');
  const [website, setWebsite] = useState(user.website ?? '');
  const [bio, setBio] = useState(user.bio ?? '');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // The browser's list leaves out aliases such as `UTC` (the server's default): the saved one is always offered, or the
  // select would show the first zone while keeping another.
  const zones = Intl.supportedValuesOf('timeZone');
  const timezones = zones.includes(timezone) ? zones : [timezone, ...zones];
  // #220: the server rejects anything that isn't an absolute http(s) URL, so say so here rather than letting Save fail
  // with a raw validation error.
  const websiteInvalid = website.trim() !== '' && !isProfileWebsiteUrl(website.trim());
  const dirty = displayName !== user.displayName || title !== (user.title ?? '') || timezone !== (user.timezone || 'UTC') || website !== (user.website ?? '') || bio !== (user.bio ?? '');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // #434: '' clears the title (the server trims, so a blank field is "unset").
      const me = await api.patchMe({ displayName, title: title.trim(), timezone, website: website.trim(), bio });
      props.onUser(me);
      setSaved(true);
      props.onProfileSaved?.();
    } catch (err) {
      setError(errorText(err, 'failed'));
    } finally {
      setSaving(false);
    }
  };

  const pickAvatar = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setAvatarBusy(true);
    setError(null);
    try {
      props.onUser(await api.uploadAvatar(file));
    } catch (err) {
      setError(errorText(err, 'avatar failed'));
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <section className="as-section" data-testid="account-settings-profile">
      <div className="as-avatar-row">
        {props.avatarSrc ? (
          <img src={props.avatarSrc} alt="avatar" className="as-avatar" data-testid="profile-avatar" />
        ) : (
          <span className="as-avatar as-avatar-initial" data-testid="profile-avatar">
            {user.displayName.slice(0, 1).toUpperCase()}
          </span>
        )}
        <label className="as-link">
          {avatarBusy ? 'Uploading…' : 'Change avatar…'}
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden data-testid="profile-avatar-input" onChange={(e) => void pickAvatar(e.target.files)} />
        </label>
      </div>

      <Field label="Display name">
        <input data-testid="profile-name" className="as-input" value={displayName} onChange={(e) => (setDisplayName(e.target.value), setSaved(false))} />
        {props.address && (
          <p data-testid="profile-address" className="as-hint as-select" title={props.address}>
            {props.address}
          </p>
        )}
      </Field>
      {/* #434: directly under the name: the two together are what a Directory card shows, so they are edited together. */}
      <Field label="Title" hint="Shown under your name in the Directory.">
        <input data-testid="profile-title" placeholder="Title (optional)" maxLength={PROFILE_TITLE_MAX} className="as-input" value={title} onChange={(e) => (setTitle(e.target.value), setSaved(false))} />
      </Field>
      <Field label="Timezone">
        <select data-testid="profile-timezone" className="as-input" value={timezone} onChange={(e) => (setTimezone(e.target.value), setSaved(false))}>
          {timezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Website">
        <input
          data-testid="profile-website"
          type="url"
          placeholder="https://example.com"
          maxLength={PROFILE_WEBSITE_MAX}
          className={`as-input${websiteInvalid ? ' as-invalid' : ''}`}
          value={website}
          onChange={(e) => (setWebsite(e.target.value), setSaved(false))}
        />
        <p data-testid="profile-website-error" className={`as-hint${websiteInvalid ? ' as-hint-error' : ''}`}>
          {websiteInvalid ? 'Must be a full link starting with http:// or https://' : 'Shown on your profile card.'}
        </p>
      </Field>
      <Field
        label="Bio"
        aside={
          <span data-testid="profile-bio-count" className={`as-count${bio.length >= PROFILE_BIO_MAX ? ' as-hint-error' : ''}`}>
            {bio.length}/{PROFILE_BIO_MAX}
          </span>
        }
      >
        <textarea data-testid="profile-bio" rows={3} maxLength={PROFILE_BIO_MAX} placeholder="A sentence or two about you." className="as-input as-textarea" value={bio} onChange={(e) => (setBio(e.target.value), setSaved(false))} />
      </Field>

      <div className="as-actions">
        {saved && !dirty && !props.onCancel && (
          <span className="as-saved" data-testid="profile-saved" role="status">
            Saved
          </span>
        )}
        {props.onCancel && (
          <button type="button" className="as-button" onClick={props.onCancel}>
            Cancel
          </button>
        )}
        <button type="button" data-testid="profile-save" className="as-button as-primary" disabled={!displayName.trim() || websiteInvalid || saving || (!props.onCancel && !dirty)} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}

function NotificationsSection(props: AccountSettingsProps & { setError(e: string | null): void }) {
  const { user, api, setError } = props;
  const prefs = user.notificationPrefs;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  /** Live-saved: one PATCH per flip, shallow-merged server-side. */
  const setPref = async (key: keyof NotificationPrefs, value: boolean) => {
    setError(null);
    try {
      props.onUser(await api.patchMe({ notificationPrefs: { [key]: value } }));
    } catch (err) {
      setError(errorText(err, 'failed'));
    }
  };
  /** #489: live-saved like the prefs: a privacy switch that needed a second click to take effect would be the wrong shape. */
  const setPrivacyMode = async (value: boolean) => {
    setError(null);
    try {
      props.onUser(await api.patchMe({ privacyMode: value }));
    } catch (err) {
      setError(errorText(err, 'failed'));
    }
  };
  /** App Store 5.1.1(v) parity: the same self-service deletion the apps offer. */
  const deleteAccount = async () => {
    setDeleteBusy(true);
    setError(null);
    try {
      await api.deleteAccount();
      props.onDeleted();
    } catch (err) {
      setError(errorText(err, 'failed'));
      setDeleteBusy(false);
    }
  };

  return (
    <>
      <h3 className="as-heading">Notifications</h3>
      <p className="as-hint">Off means no banner — everything still lands in the 🔔 list.</p>
      <PrefToggle testid="pref-dm" label="Direct messages" hint="any message in a DM" checked={prefs.dm !== false} onChange={(v) => void setPref('dm', v)} />
      <PrefToggle testid="pref-mention" label="Mentions of me" hint="@you" checked={prefs.mention !== false} onChange={(v) => void setPref('mention', v)} />
      <PrefToggle testid="pref-group-mention" label="Group mentions" hint="@here, @channel" checked={prefs.groupMention !== false} onChange={(v) => void setPref('groupMention', v)} />
      <PrefToggle testid="pref-thread-reply" label="Thread replies" hint="threads you started or joined" checked={prefs.threadReply !== false} onChange={(v) => void setPref('threadReply', v)} />
      <PrefToggle testid="pref-reaction" label="Reactions" hint="someone reacts to your message" checked={prefs.reaction !== false} onChange={(v) => void setPref('reaction', v)} />
      <PrefToggle testid="pref-channel-invite" label="Channel invites" hint="someone adds you to a channel" checked={prefs.channelInvite !== false} onChange={(v) => void setPref('channelInvite', v)} />
      <PrefToggle testid="pref-sound" label="Play a sound" hint="with every banner" checked={prefs.sound !== false} onChange={(v) => void setPref('sound', v)} />
      {props.persistentBanners && (
        <PrefToggle testid="pref-persistent" label="Keep banners on screen" hint="until dismissed (browser permitting)" checked={prefs.persistentBanners === true} onChange={(v) => void setPref('persistentBanners', v)} />
      )}

      {/* #489: the address sits here rather than with the editable fields because it is not editable, and because
          "here is your email, here is the switch that hides it" is one thought. */}
      <h3 className="as-heading as-divided">Privacy</h3>
      <p className="as-text">
        <span className="as-muted">Email: </span>
        <span data-testid="profile-email" className="as-select">
          {user.email}
        </span>
      </p>
      <PrefToggle testid="pref-privacy-mode" label="Privacy mode" hint="Hide your email and remove you from the Directory." checked={user.privacyMode} onChange={(v) => void setPrivacyMode(v)} />

      <div className="as-divided as-danger-zone">
        {confirmingDelete ? (
          <div data-testid="profile-delete-confirm">
            <p className="as-text as-hint-error">
              Permanently delete {user.email} on {props.serverOrigin}? You leave every workspace on this server, your email is freed for future use, and this cannot be undone. Past messages remain,
              attributed to your name.
            </p>
            <div className="as-actions as-actions-start">
              <button type="button" data-testid="profile-delete-really" className="as-button as-destructive" disabled={deleteBusy} onClick={() => void deleteAccount()}>
                {deleteBusy ? 'Deleting…' : 'Delete my account'}
              </button>
              <button type="button" className="as-button" disabled={deleteBusy} onClick={() => setConfirmingDelete(false)}>
                Keep my account
              </button>
            </div>
          </div>
        ) : (
          <button type="button" data-testid="profile-delete" className="as-link as-hint-error" onClick={() => setConfirmingDelete(true)}>
            Delete account…
          </button>
        )}
      </div>
    </>
  );
}

function Field({ label, hint, aside, children }: { label: string; hint?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="as-field">
      <div className="as-label-row">
        <span className="as-label">{label}</span>
        {aside}
      </div>
      {children}
      {hint && <p className="as-hint">{hint}</p>}
    </div>
  );
}

/** One live-saved toggle. */
function PrefToggle({ label, hint, checked, onChange, testid }: { label: string; hint?: string; checked: boolean; onChange(value: boolean): void; testid: string }) {
  return (
    <label className="as-toggle">
      <input type="checkbox" data-testid={testid} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="as-muted"> — {hint}</span>}
      </span>
    </label>
  );
}
