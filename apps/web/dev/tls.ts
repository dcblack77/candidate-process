import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";

/**
 * Certificado del servidor de desarrollo (BLUEPRINT §10).
 *
 * POR QUÉ EXISTE: grabar la entrevista (§24) necesita `getUserMedia` y
 * `getDisplayMedia`, y el navegador solo expone esas funciones en un
 * "contexto seguro" — HTTPS o localhost. No es una restricción nuestra que
 * podamos levantar: sobre `http://192.168.1.10:5173` la propiedad
 * `navigator.mediaDevices` directamente no existe. Para usar la aplicación
 * desde otro equipo de la red hace falta TLS, aunque sea con un certificado
 * que solo vale aquí dentro.
 *
 * Es un certificado autofirmado: la primera vez cada navegador avisa de que
 * no lo conoce y hay que aceptar la excepción una vez. Eso NO añade
 * seguridad real (sigue sin haber autenticación, §08) — solo desbloquea el
 * micrófono. La protección de estos datos sigue siendo la red de confianza.
 *
 * El certificado se guarda en `certs/` (ignorado por git) para que la
 * excepción que acepta cada dispositivo siga valiendo entre reinicios. Se
 * regenera solo cuando caduca o cuando la máquina cambia de IP, que es justo
 * cuando el anterior ha dejado de servir.
 */

export interface TlsMaterial {
    key: string;
    cert: string;
}

/** Nombres e IPs por los que se puede llegar a esta máquina. */
export interface LocalHosts {
    dns: string[];
    ips: string[];
}

/** Vigencia del certificado. 397 días: iOS y Safari rechazan más de 398. */
const VALIDITY_DAYS = 397;

/** Margen para renovar antes de que caduque de verdad. */
const RENEW_BEFORE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reúne por dónde es alcanzable esta máquina: `localhost`, su nombre de red
 * (y el `.local` de mDNS) y todas sus IPv4 no internas.
 *
 * Sin IPv6 a propósito: el navegador valida el certificado contra lo que hay
 * escrito en la barra de direcciones, y nadie teclea una IPv6. Quien entre
 * por `https://localhost:5173` sobre `::1` valida igualmente contra el
 * nombre DNS.
 */
export function collectLocalHosts(
    interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
    machineName: string,
): LocalHosts {
    const dns = new Set(["localhost"]);
    const ips = new Set(["127.0.0.1"]);

    const name = machineName.trim().toLowerCase();
    if (isIP(name)) {
        // En esta máquina el hostname ES su IP. Como SAN de tipo DNS no sirve
        // de nada: el navegador valida una IP contra los SAN de tipo IP.
        if (isIP(name) === 4) {
            ips.add(name);
        }
    } else if (name && name !== "localhost") {
        dns.add(name);
        // Fedora y macOS resuelven `<nombre>.local` por mDNS sin configurar nada.
        if (!name.includes(".")) {
            dns.add(`${name}.local`);
        }
    }

    for (const entries of Object.values(interfaces)) {
        for (const entry of entries ?? []) {
            if (entry.family === "IPv4" && !entry.internal) {
                ips.add(entry.address);
            }
        }
    }

    return { dns: [...dns], ips: [...ips] };
}

/**
 * Extrae los SAN de un certificado. `subjectAltName` viene como
 * `DNS:localhost, IP Address:192.168.1.10`.
 */
function readSubjectAltNames(certificate: X509Certificate): Set<string> {
    const raw = certificate.subjectAltName ?? "";
    const names = new Set<string>();
    for (const part of raw.split(",")) {
        const separator = part.indexOf(":");
        if (separator === -1) {
            continue;
        }
        names.add(part.slice(separator + 1).trim());
    }
    return names;
}

/**
 * ¿Sigue sirviendo este certificado? Debe cubrir todos los nombres e IPs
 * actuales y no estar a punto de caducar.
 */
export function certificateCovers(
    certPem: string,
    hosts: LocalHosts,
    now: Date,
): boolean {
    let certificate: X509Certificate;
    try {
        certificate = new X509Certificate(certPem);
    } catch {
        // Archivo corrupto o a medio escribir: se regenera.
        return false;
    }

    const expiresAt = new Date(certificate.validTo).getTime();
    if (
        Number.isNaN(expiresAt) ||
        expiresAt - now.getTime() < RENEW_BEFORE_DAYS * DAY_MS
    ) {
        return false;
    }

    const covered = readSubjectAltNames(certificate);
    return [...hosts.dns, ...hosts.ips].every((host) => covered.has(host));
}

/**
 * Devuelve el certificado de `dir`, generándolo si falta o si ya no cubre
 * las direcciones actuales de la máquina.
 *
 * Lanza si no puede escribir en disco o si la generación falla: quien llama
 * decide si eso tumba el arranque o se cae a HTTP sin cifrar.
 */
export async function ensureDevCertificate(
    dir: string,
    now: Date = new Date(),
): Promise<TlsMaterial> {
    const hosts = collectLocalHosts(networkInterfaces(), hostname());
    const keyPath = join(dir, "web-key.pem");
    const certPath = join(dir, "web-cert.pem");

    if (existsSync(keyPath) && existsSync(certPath)) {
        const cert = readFileSync(certPath, "utf8");
        if (certificateCovers(cert, hosts, now)) {
            return { key: readFileSync(keyPath, "utf8"), cert };
        }
    }

    const generated = await generate(
        [{ name: "commonName", value: hosts.dns[0] ?? "localhost" }],
        {
            algorithm: "sha256",
            keySize: 2048,
            notBeforeDate: now,
            notAfterDate: new Date(now.getTime() + VALIDITY_DAYS * DAY_MS),
            extensions: [
                // cA: permite además INSTALARLO como raíz de confianza en un
                // dispositivo para no volver a ver el aviso. Aceptar la
                // excepción a mano funciona igual y no requiere esto.
                { name: "basicConstraints", cA: true },
                {
                    name: "keyUsage",
                    digitalSignature: true,
                    keyEncipherment: true,
                    keyCertSign: true,
                },
                { name: "extKeyUsage", serverAuth: true },
                {
                    name: "subjectAltName",
                    altNames: [
                        ...hosts.dns.map((value) => ({
                            type: 2 as const,
                            value,
                        })),
                        ...hosts.ips.map((ip) => ({ type: 7 as const, ip })),
                    ],
                },
            ],
        },
    );

    mkdirSync(dir, { recursive: true });
    // La clave privada, solo para el dueño.
    writeFileSync(keyPath, generated.private, { mode: 0o600 });
    writeFileSync(certPath, generated.cert, { mode: 0o644 });

    return { key: generated.private, cert: generated.cert };
}
