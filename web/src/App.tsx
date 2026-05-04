import { Navigate, Route, Routes } from "react-router-dom";
import { useSession } from "./hooks/useSession";
import Login from "./pages/Login";
import Layout from "./components/Layout";
import Overview from "./pages/Overview";
import Analysis from "./pages/Analysis";
import Events from "./pages/Events";
import Credentials from "./pages/Credentials";
import Pricing from "./pages/Pricing";
import AuthFiles from "./pages/AuthFiles";
import ImportPage from "./pages/Import";
import { RefreshProvider } from "./lib/refresh";

export default function App() {
  const { session, loading, login, logout, refresh } = useSession();

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted">
        Loading…
      </div>
    );
  }

  if (session && session.auth_required && !session.authenticated) {
    return <Login onLogin={login} />;
  }

  return (
    <RefreshProvider>
      <Layout
        authRequired={!!session?.auth_required}
        onLogout={async () => {
          await logout();
          await refresh();
        }}
      >
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/analysis" element={<Analysis />} />
          <Route path="/events" element={<Events />} />
          <Route path="/credentials" element={<Credentials />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/auth-files" element={<AuthFiles />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </RefreshProvider>
  );
}
