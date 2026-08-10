import { Server as HttpServer } from "node:http";
import { AppExpress } from "@expressots/adapter-express";
import { AppContainer, interfaces } from "@expressots/core";
import { Application as ExpressApplication } from "express";
import { AiModule } from "./ai/ai.module";
import { CoreModule } from "./app.module";
import { CandidatesModule } from "./candidates/candidates.module";
import { CvModule } from "./cv/cv.module";
import { loadEnv } from "./env";
import { ExportModule } from "./export/export.module";
import { HealthModule } from "./health/health.module";
import { InterviewModule } from "./interview/interview.module";
import { ProcessModule } from "./process/process.module";
import { QuestionsModule } from "./questions/questions.module";
import { RankingModule } from "./ranking/ranking.module";
import { ScoringModule } from "./scoring/scoring.module";
import { currentUserMiddleware } from "./security/current-user.middleware";
import { errorHandler } from "./shared/error-handler";

/** Direcciones que consideramos locales al verificar el bind real. */
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Aplicación ExpressoTS.
 *
 * Ciclo de vida:
 *   globalConfiguration      → configuración previa al DI.
 *   configureServices        → middlewares (parse, currentUser) y error handler.
 *   postServerInitialization → el servidor ya escucha; verificamos el bind.
 *   serverShutdown           → apagado ordenado.
 */
export class App extends AppExpress {
    private readonly container: AppContainer;

    /**
     * `coreModule` es inyectable para que los tests de integración puedan
     * sustituir CoreModule (que abre data/local.db) por un módulo con la
     * base de datos ":memory:". En producción no se pasa argumento.
     */
    constructor(coreModule: interfaces.ContainerModule = CoreModule) {
        super();
        this.container = this.configContainer([
            coreModule,
            HealthModule,
            ProcessModule,
            CandidatesModule,
            CvModule,
            AiModule,
            ScoringModule,
            InterviewModule,
            QuestionsModule,
            RankingModule,
            ExportModule,
        ]);
    }

    /**
     * Contenedor DI ya configurado. Se expone SOLO para los tests de
     * integración: necesitan resolver singletons de proceso (p. ej. el
     * contador de exportaciones por sesión) y dejarlos limpios entre casos.
     * El código de producción no lo usa: resuelve todo por @inject.
     */
    get diContainer(): AppContainer {
        return this.container;
    }

    protected override globalConfiguration(): void {
        // Sin prefijo global: las rutas del blueprint (§10) cuelgan de la raíz.
        this.forceLocalhostBinding();
    }

    override async configureServices(): Promise<void> {
        this.Middleware.parse();
        // Toda petición resuelve currentUser (BLUEPRINT §08).
        this.Middleware.add(currentUserMiddleware);
        // Manejador central de errores: nunca stack ni datos sensibles.
        this.Middleware.setErrorHandler({
            errorHandler,
            showStackTrace: false,
        });
    }

    /**
     * Segunda línea de defensa del invariante §10: si por cualquier cambio
     * del framework el servidor no quedó escuchando en una dirección local,
     * se aborta el arranque en el acto.
     */
    protected override async postServerInitialization(): Promise<void> {
        const server = await this.getHttpServer();
        const address = server.address();
        if (
            !address ||
            typeof address === "string" ||
            !LOCAL_ADDRESSES.has(address.address)
        ) {
            server.close();
            const bound =
                typeof address === "object" && address
                    ? address.address
                    : String(address);
            throw new Error(
                `La API quedó escuchando en "${bound}" en lugar de localhost. ` +
                    "Se aborta el arranque (BLUEPRINT §10: la API solo escucha en localhost).",
            );
        }
    }

    protected override async serverShutdown(): Promise<void> {}

    /**
     * Invariante (BLUEPRINT §10): la API solo escucha en localhost.
     *
     * El adapter de ExpressoTS llama a `app.listen(port, cb)` sin host, lo
     * que en Express/Node significa escuchar en TODAS las interfaces
     * (0.0.0.0). El app de Express se crea dentro de `init()` y se asigna a
     * la propiedad privada `app` justo antes de escuchar, así que
     * interceptamos esa asignación con un accessor y envolvemos su `listen`
     * para insertar siempre el host local.
     *
     * (No se puede leer el app desde `this.Middleware`: ese getter es un
     * Proxy que hace `value.bind(target)` sobre valores función, y el app de
     * Express ES una función cuyo `.bind` es el método HTTP BIND de Express.)
     */
    private forceLocalhostBinding(): void {
        const env = loadEnv();
        const patched = Symbol.for("listenPatchedToLocalhost");
        let currentApp: ExpressApplication | undefined;

        const patchListen = (app: ExpressApplication): ExpressApplication => {
            const marker = app as unknown as Record<symbol, boolean>;
            if (marker[patched]) {
                return app;
            }
            const originalListen = app.listen.bind(app) as (
                port: number,
                host: string,
                callback?: () => void,
            ) => HttpServer;
            const listenOnLocalhost = (
                port: number,
                callback?: () => void,
            ): HttpServer => originalListen(port, env.API_HOST, callback);
            (app as unknown as { listen: typeof listenOnLocalhost }).listen =
                listenOnLocalhost;
            marker[patched] = true;
            return app;
        };

        Object.defineProperty(this, "app", {
            configurable: true,
            enumerable: true,
            get: () => currentApp,
            set: (value: ExpressApplication | undefined) => {
                currentApp = value ? patchListen(value) : value;
            },
        });
    }
}
