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
import { ProcessResponseDTO } from "../api/types";

/**
 * Contexto ligero con el proceso activo (único estado global de la app).
 * GET /process responde 404 NOT_FOUND cuando no hay proceso: eso no es un
 * error para la UI, es el estado "sin proceso".
 */

interface ProcessContextValue {
    process: ProcessResponseDTO | null;
    loading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
}

const ProcessContext = createContext<ProcessContextValue | null>(null);

export function ProcessProvider({ children }: { children: ReactNode }) {
    const [process, setProcess] = useState<ProcessResponseDTO | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setProcess(await api.getProcess());
            setError(null);
        } catch (err) {
            setProcess(null);
            if (err instanceof ApiError && err.code === "NOT_FOUND") {
                setError(null);
            } else {
                setError(friendlyMessage(err));
            }
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const value = useMemo(
        () => ({ process, loading, error, refresh }),
        [process, loading, error, refresh],
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
