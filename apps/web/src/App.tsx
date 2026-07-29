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

/** Cabecera con navegación; los enlaces de datos solo si hay proceso activo. */
function Header() {
    const { process } = useProcess();
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
                        <NavLink to="/close">Cerrar proceso</NavLink>
                    </>
                )}
            </nav>
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
