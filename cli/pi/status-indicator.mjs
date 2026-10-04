// Derived from Pi status-indicator.ts, copyright (c) 2025 Mario Zechner, MIT.
// See NOTICE. The animation and border rendering are shared with Pi.
import { Loader, truncateToWidth } from '@earendil-works/pi-tui';
export class WorkingStatusIndicator extends Loader {
 constructor(ui, color) { super(ui, color, color, 'Working (esc to interrupt)'); }
 renderInBorder(width) {
  const line = super.render(width + 2)[1] ?? '';
  return truncateToWidth(line.startsWith(' ') ? line.slice(1).trimEnd() : line.trimEnd(), width, '');
 }
 renderSpinnerInBorder(width) { return truncateToWidth(this.getRenderedIndicator(), width, ''); }
 dispose() { this.stop(); }
}
