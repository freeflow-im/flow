import { describe, expect, it } from 'vitest';
import { checkVideo, videoAddress, youtubeId } from './video.ts';

describe('video addresses', () => {
  it('finds the video a YouTube link is to, in each form of link', () => {
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=42s',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      'youtu.be/dQw4w9WgXcQ',
      '  http://www.youtube.com/watch?v=dQw4w9WgXcQ ',
    ])
      expect(youtubeId(link), link).toBe('dQw4w9WgXcQ');
    for (const link of ['', 'dQw4w9WgXcQ', 'https://vimeo.com/123456789', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/channel/dQw4w9WgXcQ', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ', 'javascript:youtu.be/dQw4w9WgXcQ'])
      expect(youtubeId(link), link).toBeNull();
  });

  it('keeps a YouTube video as its watch address and a stored file as it is', () => {
    expect(videoAddress('https://youtu.be/dQw4w9WgXcQ?t=3')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(videoAddress('/api/files/wvx2szrxf804')).toBe('/api/files/wvx2szrxf804');
    expect(videoAddress('/api/files/034bf91d-1454-428f-9bc3-dd12cacd6991')).toBe('/api/files/034bf91d-1454-428f-9bc3-dd12cacd6991');
    expect(videoAddress('https://example.com/clip.mp4')).toBeNull();
  });

  it('accepts only the kept forms', () => {
    expect(checkVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(checkVideo('/api/files/wvx2szrxf804')).toBeNull();
    expect(checkVideo('https://youtu.be/dQw4w9WgXcQ')).toMatch(/Video must be/);
    expect(checkVideo('/api/files/../secret')).toMatch(/Video must be/);
    expect(checkVideo('javascript:alert(1)')).toMatch(/Video must be/);
    expect(checkVideo(undefined)).toMatch(/Video must be/);
  });
});
