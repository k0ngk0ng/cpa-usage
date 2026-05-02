import { FormEvent, useState } from "react";
import { HttpError } from "../api/client";

interface Props {
  onLogin: (password: string) => Promise<void>;
}

export default function Login({ onLogin }: Props) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onLogin(password);
    } catch (err) {
      if (err instanceof HttpError) setError(err.message);
      else setError("Login failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-panel border border-border rounded-lg p-6 space-y-4"
      >
        <div>
          <h1 className="text-xl font-semibold">CPA Usage</h1>
          <p className="text-sm text-muted mt-1">Sign in to continue.</p>
        </div>
        <label className="block text-sm">
          <span className="text-muted">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
            className="mt-1 block w-full bg-panel2 border border-border rounded px-3 py-2 outline-none focus:border-accent"
          />
        </label>
        {error && <div className="text-sm text-danger">{error}</div>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-accent text-bg py-2 rounded font-medium disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
