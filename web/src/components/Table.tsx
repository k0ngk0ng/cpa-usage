import { ReactNode } from "react";
import clsx from "clsx";

export interface Column<T> {
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  cellClassName?: string;
  align?: "left" | "right" | "center";
  sticky?: "left";
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  loading?: boolean;
}

export default function Table<T>({ columns, rows, rowKey, empty, loading }: Props<T>) {
  return (
    <div className="bg-panel border border-border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="bg-panel2 text-[11px] text-muted uppercase tracking-wider">
            <tr>
              {columns.map((c, i) => (
                <th
                  key={i}
                  className={clsx(
                    "px-2 py-1.5 font-medium whitespace-nowrap",
                    c.align === "right" && "text-right",
                    c.align === "center" && "text-center",
                    c.align !== "right" && c.align !== "center" && "text-left",
                    c.sticky === "left" && "sticky left-0 bg-panel2 z-10",
                    c.className,
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && (
              <tr>
                <td colSpan={columns.length} className="px-2 py-6 text-center text-muted">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-2 py-6 text-center text-muted">
                  {empty || "No rows."}
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((row) => (
                <tr key={rowKey(row)} className="group hover:bg-panel2/60">
                  {columns.map((c, i) => (
                    <td
                      key={i}
                      className={clsx(
                        "px-2 py-1.5 align-top",
                        c.align === "right" && "text-right tabular-nums",
                        c.align === "center" && "text-center",
                        c.sticky === "left" && "sticky left-0 bg-panel group-hover:bg-panel2/60 z-10",
                        c.className,
                        c.cellClassName,
                      )}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
