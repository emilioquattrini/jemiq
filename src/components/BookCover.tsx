import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import type { BookRecord, CatalogCandidate } from '../../shared/types';
import { COVER_UNAVAILABLE, normalizeCoverUrl, resolveBookCover } from '../../shared/covers';

type BookCoverProps = { className?: string } & (
  | { book: BookRecord; candidate?: never }
  | { candidate: CatalogCandidate; book?: never }
);

function CoverImage({ url, title, suggested, className }: { url: string | null; title: string; suggested: boolean; className?: string }) {
  const [failed, setFailed] = useState(false);
  const available = !!url && !failed;
  return <span className={`book-cover ${className || ''} ${available ? 'has-cover' : 'cover-unavailable'}`}>
    <span className="book-cover-art">
      {available ? <img src={url} alt={`Copertina di ${title || 'questo libro'}`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)}/> : <BookOpen size={24} strokeWidth={1.4} aria-hidden="true"/>}
    </span>
    {!available ? <span className="book-cover-note">{COVER_UNAVAILABLE}</span> : suggested ? <span className="book-cover-note">Copertina indicativa</span> : null}
  </span>;
}

/** The URL key resets an image failure when another edition supplies a new cover. */
export default function BookCover(props: BookCoverProps) {
  const cover = props.book ? resolveBookCover(props.book) : { url: normalizeCoverUrl(props.candidate.thumbnail), suggested: true };
  const title = props.book?.title || props.candidate?.title || '';
  return <CoverImage key={cover.url || 'unavailable'} {...cover} title={title} className={props.className}/>;
}
