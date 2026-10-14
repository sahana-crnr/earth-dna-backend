// Account roles (F7). One `const` array is the single source for the users.role
// column, the CHECK constraint in the AddUserRole migration, the @Roles()
// decorator and RolesGuard, so the four cannot drift - same pattern as
// scan.types.ts.
//
// USER is every account the app creates. ADMIN is never self-service: it is
// granted only by AdminBootstrapService from ADMIN_EMAIL, and the register DTO
// has no role field (forbidNonWhitelisted turns an attempt into a 400).
export const USER_ROLES = ['USER', 'ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const DEFAULT_USER_ROLE: UserRole = 'USER';
