# Global Connect - Backend API

[![Frontend Repository](https://img.shields.io/badge/Frontend-Repository-blue?style=flat-square&logo=github)](https://github.com/mahaH26/globalconnect_Frontend)
[![Backend Repository](https://img.shields.io/badge/Backend-Repository-green?style=flat-square&logo=github)](https://github.com/mahaH26/globalconnect_Backend)

Global Connect is a comprehensive people-management workspace platform designed to handle staff attendance, leave management, employee progression, team communication, and administrative reporting. This repository contains the backend REST API component, structured to securely manage business logic, database transactions, and role-based access control.

---

## 🛠️ Tools and Technologies

- **Language & Runtime:** Node.js, TypeScript
- **Server & Routing:** Express 5 (mounting 14 dedicated route modules)
- **Database & Auth:** Supabase (`@supabase/supabase-js`, PostgreSQL)
- **Validation & Security:** Zod (for robust request body and query string validation), CORS, dotenv
- **Export Utilities:** ExcelJS (`.xlsx`), PDFKit (Landscape A4 reports with custom headers)
- **Development Server:** `tsx` for auto-reloading during development
- **Testing Stack:** Jest, Supertest, and `@swc/jest` for high-speed TypeScript compilation

---

## 🚀 Detailed System Architecture & Features

### 1. Authentication & Role-Based Access Control (RBAC)

- **Secure Token Handling:** Routes are protected via authentication guards (`requireAuth`) that validate Supabase bearer tokens. Admin-only routes require additional manager clearance (`requireManager`).
- **Credentials & Refresh:** Endpoints support secure login, session refreshing, and password updating rules (requiring current password verification and strict character guidelines).
- **Account Status Enforcement:** Suspended or terminated accounts are automatically blocked at login and across protected requests.

### 2. GPS Attendance Engine

- **Geofencing & Verification:** Uses the Haversine formula to compute great-circle distance in meters between device coordinates and registered office locations, flagging out-of-radius check-ins.
- **Time & Grace Period Logic:** Computes local times based on configured UTC offsets, assigning "present", "late" (with grace period buffers), "early check-out", or "overtime" statuses alongside automated point rewards/penalties.
- **Summaries:** Calculates comprehensive monthly attendance statistics, expected working days, and attendance rates.

### 3. Leave Management & Team Conflicts

- **Request Processing:** Validates leave types (annual, sick, emergency, unpaid) and dates, automatically excluding weekends and ensuring balances (allowance minus approved/pending days) are respected.
- **Conflict Warning:** Scans for department colleagues with overlapping approved or pending leave to warn staff and administrators.

### 4. Employee Administration & Progression

- **Staff Management:** Admins can create pre-confirmed accounts, modify profile fields, reset passwords, and perform soft-deactivations (terminations with login bans).
- **Levels & Milestones:** Tracks points and tenure months to determine promotion eligibility, handles promotional overrides, and records notable milestones.

### 5. Dashboards, Reports, & Notifications

- **Admin Dashboard:** Pulls real-time daily metrics including total active staff, attendance rates, pending requests, and unread notifications.
- **Exportable Reports:** Generates filtered reports for attendance, lateness, absence, overtime, and progression in JSON, Excel (`.xlsx`), or PDF formats.
- **Chat & Notifications:** Manages direct and group messaging conversations (with sorted pair keys for uniqueness) alongside automated system notifications.

---

## 🧪 Testing Methodology & Coverage

- **Approach:** Automated backend tests run in-memory using Jest and Supertest (`jest --runInBand`) without exposing external network ports.
- **Test Doubles:** Supabase clients, system clocks, notification spies, and authentication headers (`x-test-role`) are fully mocked for isolated and repeatable test executions.
- **Suites:** Includes unit test suites for input validation (`validate.test.ts`), integration tests for attendance (`attendance.test.ts`) and leave (`leave.test.ts`), and security guard validations (`permissions.test.ts`, `auth-guard.test.ts`).
