/**
 * Usuario actual (BLUEPRINT §08). En MVP siempre es el Admin local, pero
 * toda acción del backend debe recibir/resolver `currentUser` para poder
 * añadir autenticación real después sin reescribir el sistema.
 */

export interface CurrentUser {
    id: string;
    role: string;
}

/** Único usuario del MVP. */
export const LOCAL_ADMIN: CurrentUser = Object.freeze({
    id: "local-admin",
    role: "admin",
});
