// Meet has two pages: its home at /meet/ and a meeting room at /meet/<id>. A room opens in its own browser tab, so a
// call goes on while the person uses the other apps (phase 1 has no mini window; docs/specs/meetings.md §9).
import { meetingIdOf } from './api';
import { MeetHome } from './components/MeetHome';
import { Room } from './components/Room';

export function App() {
  const id = meetingIdOf(window.location.pathname);
  return id ? <Room meetingId={id} /> : <MeetHome />;
}
