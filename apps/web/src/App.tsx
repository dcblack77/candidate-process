import { NavLink, Route, Routes } from "react-router-dom";
import { PrintExportProvider } from "./context/PrintExportContext";
import { ProcessProvider, useProcess } from "./context/ProcessContext";
import { CandidateDetailPage } from "./pages/CandidateDetailPage";
import { CandidatesPage } from "./pages/CandidatesPage";
import { ClosePage } from "./pages/ClosePage";
import { ExportPage } from "./pages/ExportPage";
import { ExportPrintPage } from "./pages/ExportPrintPage";
import { HomePage } from "./pages/HomePage";
import { RankingPage } from "./pages/RankingPage";

/**
 * Selector del proceso en curso. Solo aparece con más de un proceso: con uno
 * solo no hay nada que elegir y el título ya sale en Inicio.
 *
 * Cambiar aquí cambia el proceso PARA TODOS los clientes (la selección vive
 * en el servidor), de ahí el aviso del title.
 */
function ProcessSwitcher() {
    const { process, processes, select } = useProcess();
    if (processes.length < 2) {
        return null;
    }
    return (
        <label className="process-switcher">
            <span className="visually-hidden">Proceso en curso</span>
            <select
                value={process?.id ?? ""}
                onChange={(e) => void select(e.target.value)}
                title="Cambiar de proceso afecta a todos los equipos que estén usando la aplicación"
            >
                {processes.map((p) => (
                    <option key={p.id} value={p.id}>
                        {p.roleTitle}
                        {p.status === "closed" ? " (archivado)" : ""} ·{" "}
                        {p.candidateCount}
                    </option>
                ))}
            </select>
        </label>
    );
}

/** Cabecera con navegación; los enlaces de datos solo si hay proceso. */
function Header() {
    const { process, readOnly } = useProcess();
    return (
        <header className="app-header">
            <NavLink to="/" className="brand">
                Evaluación de candidatos
            </NavLink>
            <nav className="app-nav">
                <NavLink to="/" end>
                    Inicio
                </NavLink>
                {process && (
                    <>
                        <NavLink to="/candidates">Candidatos</NavLink>
                        <NavLink to="/ranking">Comparativa</NavLink>
                        <NavLink to="/export">Exportar</NavLink>
                        <NavLink to="/close">Archivar o borrar</NavLink>
                    </>
                )}
            </nav>
            {readOnly && (
                <span className="badge badge-readonly" title="Proceso archivado">
                    Solo lectura
                </span>
            )}
            <ProcessSwitcher />
        </header>
    );
}

export function App() {
    return (
        <ProcessProvider>
            {/* El export estructurado viaja en memoria de /export a
                /export/print: nunca se persiste en el navegador (§17). */}
            <PrintExportProvider>
                <Header />
                <main className="app-main">
                    <Routes>
                        <Route path="/" element={<HomePage />} />
                        <Route
                            path="/candidates"
                            element={<CandidatesPage />}
                        />
                        <Route
                            path="/candidates/:id"
                            element={<CandidateDetailPage />}
                        />
                        <Route path="/ranking" element={<RankingPage />} />
                        <Route path="/export" element={<ExportPage />} />
                        <Route
                            path="/export/print"
                            element={<ExportPrintPage />}
                        />
                        <Route path="/close" element={<ClosePage />} />
                    </Routes>
                </main>
            </PrintExportProvider>
        </ProcessProvider>
    );
}
