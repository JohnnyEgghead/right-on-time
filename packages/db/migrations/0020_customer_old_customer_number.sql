-- P4-IMPORT-FRAMES (SPECIFICATIONS v0.11 section 3; owner ruling d9901466, F-879). Forward-only (SD-40).
-- customer.old_customer_number: text null, the old system's customer number, the `customer_ref` cell of customers.csv copied as
-- written (for example C100001; API-85 oldCustomerNumber, CTL-OFC-14-06). Written only by the import runner, for each customer
-- it imports; every online or office-created customer stays null, so the column has no default and no constraint.
-- Grants (0007) are table-level, so the new column needs none. No backfill: no stored value names a customer's customer_ref,
-- so a world imported before this migration keeps null until a fresh setup imports it again. The reset (0014,
-- system.restore_world) copies world columns by name from world_snapshot, which setup creates from world after this column
-- exists; a snapshot taken before this migration has no such column, and its reset restores null, the same as that world.
ALTER TABLE world.customer ADD COLUMN old_customer_number text;
