import { NextFunction, Request, Response } from "express";
import { CurrentUser, LOCAL_ADMIN } from "./current-user";

// Ampliamos el Request de Express para que `currentUser` esté tipado
// en toda la aplicación.
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            currentUser: CurrentUser;
        }
    }
}

/**
 * Adjunta `currentUser` a cada petición (BLUEPRINT §08).
 * En MVP siempre es el Admin local; cuando exista login real, este
 * middleware será el único punto que cambie.
 */
export function currentUserMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
): void {
    req.currentUser = LOCAL_ADMIN;
    next();
}
