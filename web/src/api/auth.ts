import { apiClient } from "./client.js";
import type { LoginInput, RegisterInput, UserDTO } from "./types.js";

/** POST /auth/register, POST /auth/login, POST /auth/logout, GET /auth/me — see /docs/API.md. */
export const authApi = {
  me: () => apiClient.get<{ user: UserDTO }>("/auth/me").then((r) => r.user),
  register: (input: RegisterInput) => apiClient.post<{ user: UserDTO }>("/auth/register", input).then((r) => r.user),
  login: (input: LoginInput) => apiClient.post<{ user: UserDTO }>("/auth/login", input).then((r) => r.user),
  logout: () => apiClient.post<void>("/auth/logout", {}),
};
