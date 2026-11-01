import { useAuth } from '../auth.tsx';

/** The signed-in address and Sign out, for a page header. The desktop app has no account, so it shows nothing. */
export function Account({ before }: { before?: () => Promise<unknown> }) {
  const { user, local, logout } = useAuth();
  if (local) return null;
  return (
    <>
      <span title={user?.email}>{user?.email}</span>
      <button className="btn" onClick={() => void (before ? before() : Promise.resolve()).then(logout)}>
        Sign out
      </button>
    </>
  );
}
