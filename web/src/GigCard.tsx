import { payChip } from './money';
import { dateParts, feeText, flagsFor, STAGES, stageLabel } from './stages';
import type { Gig, StageKey } from './types';

interface Props {
  gig: Gig;
  today: string;
  canEdit: boolean;
  dragging: boolean;
  onOpen: (id: string) => void;
  onMove: (id: string, stage: StageKey) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}

export function GigCard({ gig, today, canEdit, dragging, onOpen, onMove, onDragStart, onDragEnd }: Props) {
  const d = dateParts(gig.event_date);
  const thisYear = String(Number(today.slice(0, 4)));
  const fee = feeText(gig);
  const flags = flagsFor(gig, today);
  const pay = payChip(gig.stage, gig.pay_state);
  const sub = [gig.venue_name, gig.contact_name].filter(Boolean);

  return (
    <article
      className={`card${dragging ? ' dragging' : ''}`}
      draggable={canEdit}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', gig.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(gig.id);
      }}
      onDragEnd={onDragEnd}
    >
      {d ? (
        <div className="stub" aria-hidden="true">
          <span className="mon">{d.month}</span>
          <span className="day">{d.day}</span>
          <span className="dow">{d.year !== thisYear ? d.year : d.weekday}</span>
        </div>
      ) : (
        <div className="stub undated" aria-hidden="true">
          No date
        </div>
      )}
      <div className="card-body">
        <button className="card-open" onClick={() => onOpen(gig.id)}>
          <span className="card-title">{gig.title}</span>
          {sub.map((s, i) => (
            <span className="card-sub" key={i}>
              {s}
            </span>
          ))}
          <span className="sr-only">
            {d ? `${d.weekday} ${d.month} ${d.day} ${d.year}. ` : 'No date. '}Stage: {stageLabel(gig.stage)}.
          </span>
        </button>
        {(fee || pay || gig.platform || flags.length > 0) && (
          <div className="chips">
            {fee && <span className="chip money">{fee}</span>}
            {pay && <span className={`chip${pay.alert ? ' alert' : ''}`}>{pay.text}</span>}
            {flags.map((f) => (
              <span key={f.text} className={`chip${f.tone === 'alert' ? ' alert' : ''}`}>
                {f.text}
              </span>
            ))}
            {gig.platform && <span className="chip">{gig.platform}</span>}
          </div>
        )}
        {canEdit && (
          <div className="card-move">
            <label className="sr-only" htmlFor={`move-${gig.id}`}>
              Move {gig.title} to another stage
            </label>
            <select id={`move-${gig.id}`} value={gig.stage} onChange={(e) => onMove(gig.id, e.target.value as StageKey)}>
              {STAGES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.key === gig.stage ? `Stage: ${s.label}` : `Move to ${s.label}`}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </article>
  );
}
