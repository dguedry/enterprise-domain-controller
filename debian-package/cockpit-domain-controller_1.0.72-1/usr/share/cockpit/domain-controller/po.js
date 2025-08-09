/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2024 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

// Translation strings for domain controller module
// This file will be populated by the build system with actual translations

var cockpit = cockpit || {};
cockpit.lang = cockpit.lang || {};
cockpit.lang.domain_controller = cockpit.lang.domain_controller || {};

// English fallback translations
cockpit.lang.domain_controller.en = {
    "Domain Controller": "Domain Controller",
    "Domain Status": "Domain Status",
    "Domain Statistics": "Domain Statistics",
    "Domain Actions": "Domain Actions",
    "Provision New Domain": "Provision New Domain",
    "Join Existing Domain": "Join Existing Domain",
    "Leave Domain": "Leave Domain",
    "Domain Name": "Domain Name",
    "Administrator Password": "Administrator Password",
    "Domain to Join": "Domain to Join",
    "Domain Administrator": "Domain Administrator",
    "Password": "Password",
    "Status": "Status",
    "Not joined to domain": "Not joined to domain",
    "Connected to domain": "Connected to domain",
    "Total Users": "Total Users",
    "Computers": "Computers",
    "Groups": "Groups",
    "Organizational Units": "Organizational Units",
    "Processing domain operation...": "Processing domain operation...",
    "This will remove the server from the domain and reset all domain configurations.": "This will remove the server from the domain and reset all domain configurations."
};

// Set current language to English by default
cockpit.lang.domain_controller.current = cockpit.lang.domain_controller.en;