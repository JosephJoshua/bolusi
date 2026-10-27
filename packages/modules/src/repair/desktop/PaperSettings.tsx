// The paper this PC prints slips on, set once in Settings instead of at every print. It is the
// PC's own setting, so anyone who prints may change it, and a pick saves at once.
import { Card, Section, Segmented } from '@bolusi/ui-web';

import { tn } from '../i18n.js';
import { DESK_PAPERS, PAPER_KEY, useDevicePaper } from '../paper.js';
import { useRepairRuntime } from '../runtime.js';

export function PaperSettings(): React.JSX.Element | null {
  const printing = useRepairRuntime().printing;
  const [paper, setPaper] = useDevicePaper(printing, DESK_PAPERS);
  if (printing === undefined) return null;
  return (
    <Card testId="repair.desk.paper">
      <Section title={tn('repair.paper.title')}>
        <p className="text-small text-text-muted">{tn('repair.paper.deskHint')}</p>
        <Segmented
          label={tn('repair.paper.title')}
          options={DESK_PAPERS.map((value) => ({ value, label: tn(PAPER_KEY[value]) }))}
          value={paper}
          onChange={(next) => void setPaper(next)}
          testId="repair.desk.paper.choice"
        />
      </Section>
    </Card>
  );
}
