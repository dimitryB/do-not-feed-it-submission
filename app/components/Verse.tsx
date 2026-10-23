import type { Verse as VerseData } from "../../lib/render/lore";

/**
 * A verse: the hosts' words in quotes, and the citation set like scripture —
 * the book and chapter:verse ("Max 13:06"), then the show and the date.
 */
export function Verse({ v, className = "" }: { v: VerseData; className?: string }) {
  return (
    <figure className={`verse ${className}`}>
      <blockquote>“{v.text}”</blockquote>
      <figcaption><b>{v.who} {v.at}</b> <span>{v.who === v.show ? v.date : `${v.show}, ${v.date}`}</span></figcaption>
    </figure>
  );
}
