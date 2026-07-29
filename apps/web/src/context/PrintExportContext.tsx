import {
    createContext,
    ReactNode,
    useCallback,
    useContext,
    useMemo,
    useState,
} from "react";
import { ExportStructuredResponseDTO } from "../api/types";

/**
 * Traspaso del export estructurado desde la pantalla Exportar a la vista de
 * impresión (§19), EN MEMORIA.
 *
 * Por qué en memoria y no en sessionStorage/localStorage ni en el state del
 * router:
 *
 * 1. Cada `POST /export` consume una de las 10 exportaciones de la sesión
 *    (§16). La vista de impresión NO puede volver a pedir el documento: lo
 *    recibe ya generado.
 * 2. El payload lleva datos personales (§17). sessionStorage, localStorage y
 *    el `state` del History API acaban en disco (restauración de sesión del
 *    navegador); una variable de React no. Al recargar o cerrar la pestaña no
 *    queda rastro.
 * 3. Sobrevive a la navegación SPA entre /export y /export/print, que es el
 *    único recorrido real: ir, imprimir y volver.
 *
 * Contrapartida asumida: un F5 en /export/print pierde los datos. La vista lo
 * detecta y muestra un aviso con enlace a Exportar en lugar de fallar.
 */

interface PrintExportContextValue {
    /** Último export estructurado generado en esta sesión de la SPA. */
    document: ExportStructuredResponseDTO | null;
    setDocument: (document: ExportStructuredResponseDTO) => void;
    clearDocument: () => void;
}

const PrintExportContext = createContext<PrintExportContextValue | null>(null);

export function PrintExportProvider({ children }: { children: ReactNode }) {
    const [document, setDocumentState] =
        useState<ExportStructuredResponseDTO | null>(null);

    const setDocument = useCallback(
        (next: ExportStructuredResponseDTO) => setDocumentState(next),
        [],
    );
    const clearDocument = useCallback(() => setDocumentState(null), []);

    const value = useMemo(
        () => ({ document, setDocument, clearDocument }),
        [document, setDocument, clearDocument],
    );

    return (
        <PrintExportContext.Provider value={value}>
            {children}
        </PrintExportContext.Provider>
    );
}

export function usePrintExport(): PrintExportContextValue {
    const value = useContext(PrintExportContext);
    if (!value) {
        throw new Error(
            "usePrintExport debe usarse dentro de <PrintExportProvider>",
        );
    }
    return value;
}
