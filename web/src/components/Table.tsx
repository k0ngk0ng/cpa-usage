import { ReactNode } from "react";
import clsx from "clsx";

export interface Column<T> {
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
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
        <table className="min-w-full text-sm">
          <thead className="bg-panel2 text-xs text-muted uppercase tracking-wider">
            <tr>
              {columns.map((c, i) => (
                <th
                  key={i}
                  className={clsx(
                    "px-3 py-2 font-medium",
                    c.align === "right" && "text-right",
                    c.align === "center" && "text-center",
                    c.align !== "right" && c.align !== "center" && "text-left",
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
                <td colSpan={columns.length} className="px-3 py-6 text-center text-muted">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-muted">
                  {empty || "No rows."}
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((row) => (
                <tr key={rowKey(row)} className="hover:bg-panel2/60">
                  {columns.map((c, i) => (
                    <td
                      key={i}
                      className={clsx(
                        "px-3 py-2 align-top",
                        c.align === "right" && "text-right tabular-nums",
                        c.align === "center" && "text-center",
                        c.className,
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
