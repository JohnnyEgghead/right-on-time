// SPDX-License-Identifier: AGPL-3.0-or-later
// The kit slices SURF-OFC and SURF-PBS load, in kit order: their frames load base, office, r1-common and r1-office, the
// board adds options and the admin pages r1-single (office-board, r1-admin-*, r1-pbs-a-*). The billing unit slice
// (kit.unit-pbs.css) is the billing pages' own, imported by that lane.
import '../../../styles/kit/kit.base.css';
import '../../../styles/kit/kit.office.css';
import '../../../styles/kit/kit.options.css';
import '../../../styles/kit/kit.r1-common.css';
import '../../../styles/kit/kit.r1-office.css';
import '../../../styles/kit/kit.r1-single.css';
