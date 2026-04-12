import app from "@/app.js";

export function jsonPost(path: string, body: unknown, token?: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
}

export function jsonPut(path: string, body: unknown, token?: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return app.request(path, {
    method: "PUT",
    body: JSON.stringify(body),
    headers,
  });
}

export function jsonPatch(path: string, body: unknown, token?: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return app.request(path, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers,
  });
}

export function authGet(path: string, token: string) {
  return app.request(path, {
    headers: new Headers({ Authorization: `Bearer ${token}` }),
  });
}

export function authDelete(path: string, token: string) {
  return app.request(path, {
    method: "DELETE",
    headers: new Headers({ Authorization: `Bearer ${token}` }),
  });
}
