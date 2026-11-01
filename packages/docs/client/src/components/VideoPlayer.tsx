// A video placed in a presentation or a document (shared/video.ts): its still with a play mark, and the
// player itself. A stored file plays in the browser's player, a YouTube video in YouTube's frame.
import { youtubeEmbedUrl, youtubeId, youtubePoster } from '../../../shared/video.ts';

/** The still of a video: what a slide or a page shows until it is played. It takes no clicks of its own. */
export function VideoPoster({ src }: { src: string }) {
  const yt = youtubeId(src);
  return (
    <div className="video-poster">
      {yt ? <img src={youtubePoster(yt)} alt="" draggable={false} /> : <video src={`${src}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} />}
      <span className="video-play-mark" aria-hidden="true" />
    </div>
  );
}

export function VideoPlayer({ src, autoPlay, title }: { src: string; autoPlay?: boolean; title?: string }) {
  const yt = youtubeId(src);
  if (yt) return <iframe className="video-player" src={youtubeEmbedUrl(yt, autoPlay)} title={title || 'YouTube video'} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />;
  return <video className="video-player" src={src} controls autoPlay={autoPlay} playsInline title={title} />;
}
