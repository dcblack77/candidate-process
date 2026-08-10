import {
    createContext,
    ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import { api, ApiError } from "../api/client";
import { friendlyMessage } from "../api/errors";
import { ProcessListItemDTO, ProcessResponseDTO } from "../api/types";

/**
 * Contexto con el proceso seleccionado y la lista de procesos (único estado
 * global de la app).
 *
 * GET /process responde 404 NOT_FOUND cuando no hay ninguno seleccionado:
 * eso no es un error para la UI, es el estado "sin proceso".
 *
 * `readOnly` resume el estado archivado para que las pantallas no repitan la
 * comprobación. Es una ayuda de presentación: quien manda es el backend, que
 * rechaza toda escritura sobre un proceso archivado con PROCESS_CLOSED (§09:
 * los permisos no se validan ocultando botones).
 */

interface ProcessContextValue {
    process: ProcessResponseDTO | null;
    processes: ProcessListItemDTO[];
    loading: boolean;
    error: string | null;
    /** true si hay proceso seleccionado y está archivado. */
    readOnly: boolean;
    refresh: () => Promise<void>;
    /** Cambia de proceso; afecta a todos los clientes conectados. */
    select: (id: string) => Promise<void>;
}

const ProcessContext = createContext<ProcessContextValue | null>(null);

export function ProcessProvider({ children }: { children: ReactNode }) {
    const [process, setProcess] = useState<ProcessResponseDTO | null>(null);
    const [processes, setProcesses] = useState<ProcessListItemDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        // La lista se pide aparte del proceso actual: que no haya ninguno
        // seleccionado (404) no debe impedir enumerar los que existan.
        const [current, list] = await Promise.allSettled([
            api.getProcess(),
            api.listProcesses(),
        ]);

        if (current.status === "fulfilled") {
            setProcess(current.value);
            setError(null);
        } else {
            setProcess(null);
            const err = current.reason;
            setError(
                err instanceof ApiError && err.code === "NOT_FOUND"
                    ? null
                    : friendlyMessage(err),
            );
        }

        if (list.status === "fulfilled") {
            setProcesses(list.value);
        } else {
            setProcesses([]);
        }

        setLoading(false);
    }, []);

    const select = useCallback(
        async (id: string) => {
            try {
                await api.selectProcess(id);
                setError(null);
            } catch (err) {
                setError(friendlyMessage(err));
            }
            await refresh();
        },
        [refresh],
    );

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const value = useMemo(
        () => ({
            process,
            processes,
            loading,
            error,
            readOnly: process?.status === "closed",
            refresh,
            select,
        }),
        [process, processes, loading, error, refresh, select],
    );

    return (
        <ProcessContext.Provider value={value}>
            {children}
        </ProcessContext.Provider>
    );
}

export function useProcess(): ProcessContextValue {
    const value = useContext(ProcessContext);
    if (!value) {
        throw new Error("useProcess debe usarse dentro de <ProcessProvider>");
    }
    return value;
}
