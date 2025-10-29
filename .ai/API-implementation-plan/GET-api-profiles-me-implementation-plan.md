# API Endpoint Implementation Plan: GET /api/profiles/me

## 1. Endpoint Overview

This endpoint retrieves the public profile of the currently authenticated user. It provides essential user information like display name and avatar URL, which is used throughout the application's UI.

## 2. Request Details

- **HTTP Method:** `GET`
- **URL Structure:** `/api/profiles/me`
- **Parameters:** None. The user is identified via the session managed by Astro middleware.
- **Request Body:** None.

## 3. Used Types

- **Response DTO:** `ProfileDTO` from `src/types.ts`.
  ```typescript
  export type ProfileDTO = Pick<
    Tables<"profiles">,
    "user_id" | "display_name" | "avatar_url" | "created_at" | "updated_at"
  >;
  ```
- **Command Models:** None.

## 4. Response Details

- **Success (200 OK):** Returns a JSON object with the user's profile data.
  ```json
  {
    "user_id": "a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6",
    "display_name": "John Doe",
    "avatar_url": "https://example.com/avatar.png",
    "created_at": "2025-10-29T10:00:00.000Z",
    "updated_at": "2025-10-29T11:30:00.000Z"
  }
  ```
- **Error (401 Unauthorized):** Returned if the user is not authenticated.
- **Error (404 Not Found):** Returned if the user is authenticated but has no corresponding entry in the `profiles` table.
- **Error (500 Internal Server Error):** Returned for any unexpected server-side issues (e.g., database connection failure).

## 5. Data Flow

1. A `GET` request is made to `/api/profiles/me`.
2. The Astro middleware (`src/middleware/index.ts`) intercepts the request, validates the Supabase session cookie, and attaches the `user` and `supabase` client to `context.locals`.
3. The API route handler at `src/pages/api/profiles/me.ts` is executed.
4. The handler checks if `context.locals.user` exists. If not, it immediately returns a 401 response.
5. The handler calls the `ProfileService.getProfileByUserId(supabase, user.id)` method.
6. The `ProfileService` queries the `profiles` table in the Supabase database for a record where `user_id` matches the authenticated user's ID.
7. If a profile is found, the service returns the `ProfileDTO`.
8. If no profile is found, the service returns `null`.
9. The API route handler checks the service's return value. If `null`, it returns a 404 response.
10. If a profile DTO is returned, the handler sends a 200 OK response with the DTO as the JSON body.

## 6. Security Considerations

- **Authentication:** Access is strictly limited to authenticated users. The endpoint relies entirely on the session validation performed by the Astro middleware, which should be robust.
- **Authorization:** Users can only access their own profile. The database query is explicitly filtered by the `user_id` from the server-side session (`context.locals.user.id`), preventing any possibility of a user requesting another user's profile.
- **Data Validation:** No user input is processed, minimizing the risk of injection or manipulation attacks.

## 7. Performance Considerations

- The query is a simple primary key lookup on the `profiles` table (`SELECT ... WHERE user_id = ?`), which is highly performant.
- The `profiles` table should have a primary key index on `user_id` by default, ensuring fast lookups.
- The payload size is small, so network latency should be minimal. No significant performance bottlenecks are anticipated.

## 8. Implementation Steps

1.  **Create Service Directory:** If it doesn't already exist, create the directory `src/lib/services`.
2.  **Create Profile Service:** Create a new file `src/lib/services/profile.service.ts`.
    - Implement a `ProfileService` class.
    - Add a static method `getProfileByUserId(supabase: SupabaseClient, userId: string): Promise<ProfileDTO | null>`.
    - This method will execute the Supabase query: `supabase.from('profiles').select().eq('user_id', userId).single()`.
    - It should handle the case where `data` is null (profile not found) and return `null`.
    - If data is found, it should map the row to the `ProfileDTO` and return it.
    - Handle potential query errors by logging them and re-throwing or returning a specific error type.
3.  **Create API Route:** Create the API endpoint file `src/pages/api/profiles/me.ts`.
4.  **Implement Route Handler:**
    - Export a `GET` function that accepts the `APIContext`.
    - Set `export const prerender = false;` to ensure the endpoint is always dynamically rendered.
    - Retrieve the `user` and `supabase` client from `context.locals`.
    - If `!context.locals.user`, return a `new Response(null, { status: 401 })`.
    - Call `ProfileService.getProfileByUserId` with the user's ID.
    - If the result is `null`, return a `new Response(null, { status: 404, statusText: "Profile not found" })`.
    - If a profile is returned, respond with a JSON representation of the `ProfileDTO` and a `200 OK` status.
    - Wrap the logic in a `try...catch` block to handle unexpected errors from the service layer and return a generic 500 error.
5.  **Update Middleware (If Needed):** Ensure the middleware at `src/middleware/index.ts` correctly handles session validation and attaches `user` and `supabase` to `context.locals`. This should already be in place for authenticated routes.
