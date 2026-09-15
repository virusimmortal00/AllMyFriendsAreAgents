import { useMemo, useState, type ReactNode } from "react";

export interface ListViewColumn<Row> {
  readonly key: string;
  readonly label: string;
  readonly render: (row: Row) => ReactNode;
  /** Plain value used for sorting; columns without one are not sortable. */
  readonly sortValue?: (row: Row) => string | number;
  readonly width?: string;
}

/**
 * Windows 95 ListView in Details mode: raised column headers over an inset white
 * table. Clicking a sortable header sorts by it; clicking again reverses the order.
 */
export function ListView<Row>({ label, columns, rows, rowKey, empty, initialSort, isSelected, className = "" }: {
  label: string;
  columns: readonly ListViewColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  empty: ReactNode;
  initialSort?: string;
  /** Highlights the row with the classic selection color; selection itself stays with the row's own control. */
  isSelected?: (row: Row) => boolean;
  className?: string;
}) {
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 } | null>(initialSort ? { key: initialSort, direction: 1 } : null);
  const sorted = useMemo(() => {
    const column = sort ? columns.find((candidate) => candidate.key === sort.key) : undefined;
    if (!sort || !column?.sortValue) return rows;
    const value = column.sortValue;
    return [...rows].sort((left, right) => {
      const a = value(left); const b = value(right);
      return (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))) * sort.direction;
    });
  }, [columns, rows, sort]);

  return <div className={`list-view ${className}`.trim()}>
    <table aria-label={label}>
      <colgroup>{columns.map((column) => <col key={column.key} style={column.width ? { width: column.width } : undefined} />)}</colgroup>
      <thead><tr>{columns.map((column) => {
        const active = sort?.key === column.key;
        return <th key={column.key} scope="col" aria-sort={active ? sort.direction === 1 ? "ascending" : "descending" : undefined}>
          {column.sortValue ? <button type="button" onClick={() => setSort((current) => ({ key: column.key, direction: current?.key === column.key ? (current.direction === 1 ? -1 : 1) : 1 }))}>
            {column.label}<span className="list-view__sort" aria-hidden="true">{active ? sort.direction === 1 ? "▲" : "▼" : ""}</span>
          </button> : <span>{column.label}</span>}
        </th>;
      })}</tr></thead>
      <tbody>{sorted.length ? sorted.map((row) => <tr key={rowKey(row)} className={isSelected?.(row) ? "is-selected" : undefined}>{columns.map((column) => <td key={column.key}>{column.render(row)}</td>)}</tr>)
        : <tr><td className="list-view__empty" colSpan={columns.length}>{empty}</td></tr>}</tbody>
    </table>
  </div>;
}
