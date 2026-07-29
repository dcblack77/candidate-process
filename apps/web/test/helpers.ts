import { vi } from "vitest";

/**
 * Utilidades de test: fetch mockeado (NUNCA se llama a la API real).
 */

export interface FetchCall {
    url: string;
    init: RequestInit;
}

/** Respuesta mínima compatible con lo que usa el cliente (ok/status/json). */
export function jsonResponse(data: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => data,
    } as unknown as Response;
}

/**
 * Instala un fetch mockeado que resuelve por prefijo "MÉTODO ruta"
 * (p. ej. "GET /api/candidates"). Devuelve el mock y el registro de llamadas.
 */
export function installFetchMock(
    routes: Record<string, () => Response | Promise<Response>>,
) {
    const calls: FetchCall[] = [];
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ url, init: init ?? {} });
        const key = Object.keys(routes).find((route) => {
            const [routeMethod, routePath] = route.split(" ");
            return method === routeMethod && url === routePath;
        });
        if (!key) {
            throw new Error(`Ruta no mockeada en el test: ${method} ${url}`);
        }
        return routes[key]!();
    });
    vi.stubGlobal("fetch", mock);
    return { mock, calls };
}
