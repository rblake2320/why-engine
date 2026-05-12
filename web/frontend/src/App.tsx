import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import NewCase from "./pages/NewCase.tsx";
import CaseDetail from "./pages/CaseDetail.tsx";
import AuditPage from "./pages/AuditPage.tsx";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="new" element={<NewCase />} />
        <Route path="cases/:caseId" element={<CaseDetail />} />
        <Route path="audit" element={<AuditPage />} />
      </Route>
    </Routes>
  );
}
