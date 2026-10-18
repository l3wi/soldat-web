import type { ReactNode } from 'react';

export function Row({ number, children, onClick, onHighlight, disabled = false, selected = false }: { number: number; children: ReactNode; onClick(): void; onHighlight?(): void; disabled?: boolean; selected?: boolean; }) {
    return <button type="button" className={`menu-row${selected ? ' active' : ''}`} data-menu-row disabled={disabled} onClick={onClick} onPointerEnter={onHighlight} onFocus={onHighlight}><span className="number" aria-hidden="true">{number}</span>{children}</button>;
}
