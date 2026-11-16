// Meet has two pages: its home at /meet/ and a meeting room at /meet/<code>. A room opens in its own browser tab, so a
// call goes on while the person uses the other apps (phase 1 has no mini window; docs/specs/meetings.md §9).
import { meetingRefOf } from './api';
import { MeetHome } from './components/MeetHome';
import { Room } from './components/Room';

export function App() {
  const ref = meetingRefOf(window.location.pathname);
  return ref ? <Room meetingRef={ref} /> : <MeetHome />;
}
