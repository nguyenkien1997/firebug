/* See license.txt for terms of usage */

define([
    "firebug/firebug",
    "firebug/lib/trace",
    "firebug/lib/domplate",
    "firebug/lib/dom",
    "firebug/lib/css",
    "firebug/lib/string",
    "firebug/lib/promise",
    "firebug/lib/events",
    "firebug/lib/options",
    "firebug/chrome/domTree",
    "firebug/dom/toggleBranch",
],
function(Firebug, FBTrace, Domplate, Dom, Css, Str, Promise, Events, Options, DomTree,
    ToggleBranch) {

"use strict";

// ********************************************************************************************* //
// Constants

var {domplate, TR, TD, DIV, SPAN, TAG} = Domplate;

var Trace = FBTrace.to("DBG_DOMBASETREE");
var TraceError = FBTrace.to("DBG_ERRORS");

// Asynchronous tree population is good for UI (avoids UI freezing), but causes flickering.
// Bump the slice size, we'll see what the UX will be. Note that the first slice of data
// is inserted synchronously, so the tree population can be actually synchronous (no UI fleshing)
// in most cases (i.e. in cases where the number of children isn't bigger than 'insertSliceSize').
// Of course it assumes that the data provider is also synchronous (it is in most cases, even
// asynchronous data from the back-end are cached after fetch and the access is synchronous
// since then).
var insertSliceSize = 100;
var insertInterval = 40;

// ********************************************************************************************* //
// DOM Tree Implementation

function DomBaseTree()
{
}

/**
 * @domplate This tree widget is derived from basic {@DomTree} and appends logic such as:
 * 1) Long string expansion.
 * 2) Presentation state persistence (expanded tree nodes).
 * 3) Asynchronous population (so, the UI doesn't freeze when an item is expanded and
 * there is a lot of children).
 * 4) Read only flag and custom styling.
 * 5) Custom rowTag for displaying DOM objects and properties.
 * 6) Support for tooltips
 * 7) Support for label prefixes (getters and setters)
 *
 * xxxHonza TODOs:
 * - expandRowAsync: it should be possible to cancel the population process, e.g. if the user
 * closes the node before it's fully populated or if the tree is refreshed/destroyed.
 * This is very important performance improvement (especially when the user is stepping
 * quickly in the debugger, which requires a lot of UI tree-updates).
 * - restoreState: it should be possible to expand/restore a node as soon as it's available in
 * the tree. The logic doesn't have to wait till the entire tree-level is populated.
 * - Fire events for a11y?
 * - expandRowAsync: should not generate bunch of timeouts in advance. It should be done
 * step by step, which would also support cancel.
 */
var BaseTree = DomTree.prototype;
DomBaseTree.prototype = domplate(BaseTree,
/** @lends DomBaseTree */
{
    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Domplate

    domRowTag:
        TR({"class": "memberRow $member.open $member.type\\Row",
            _domObject: "$member",
            _repObject: "$member",
            $hasChildren: "$member|hasChildren",
            $cropped: "$member|getValue|isCropped",
            role: "presentation",
            level: "$member.level"},
            TD({"class": "memberLabelCell", style: "padding-left: $member|getIndent\\px",
                role: "presentation"},
                DIV({"class": "memberLabel $member.type\\Label", title: "$member|getTitle"},
                    SPAN({"class": "memberLabelPrefix"}, "$member|getPrefix"),
                    SPAN({title: "$member|getMemberNameTooltip"}, "$member|getLabel")
                )
            ),
            TD({"class": "memberValueCell", $readOnly: "$member.readOnly",
                role: "presentation"},
                TAG("$member|getValueTag", {object: "$member|getValue"})
            )
        ),

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Domplate Accessors

    getRowTag: function(member)
    {
        return this.domRowTag;
    },

    hasChildren: function(member)
    {
        // hasChildren class is set even for cropped strings (there are no real children),
        // so the tree logic treat them as an expandable tree-items and the user can
        // 'expand' to see the entire string.
        var isExpandable = member.hasChildren || this.isCropped(member.value);
        return isExpandable ? "hasChildren" : "";
    },

    isCropped: function(value)
    {
        var cropLength = Options.get("stringCropLength");
        return typeof(value) == "string" && value.length > cropLength;
    },

    getMemberNameTooltip: function(member)
    {
        return member.title || member.scopeNameTooltip;
    },

    getPrefix: function(member)
    {
        return member.prefix || "";
    },

    getTitle: function(member)
    {
        // If the title is empty return undefined, so the 'title' attribute
        // is not even created.
        return member.title || undefined;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Persistence

    /**
     * Save DomTree state (i.e. a structure of expanded nodes), so they can be re-expanded later.
     * The method executes synchronously and stores all data into the passed state object.
     *
     * @param {@ToggleBranch} state The state info is stored into this object.
     */
    saveState: function(state)
    {
        if (!this.element)
            return;

        var rows = this.element.querySelectorAll(".memberRow.opened");
        for (var i=0; i<rows.length; i++)
        {
            var row = rows[i];
            var path = this.getPath(row);

            // Mark the path in the toggle tree
            var toggles = state;
            for (var j=0; j<path.length; ++j)
            {
                var name = path[j];
                if (toggles.get(name))
                    toggles = toggles.get(name);
                else
                    toggles = toggles.set(name, new ToggleBranch.ToggleBranch());
            }
        }

        if (Trace.active)
            Trace.sysout("domBaseTree.saveState", state.clone());
    },

    /**
     * Restore presentation state of DomTree. The restoration process is asynchronous.
     * Use the return {@Promise} object to watch when the state is fully restored.
     *
     * @param {@ToggleBranch} toggles The state info is loaded from this object.
     * @param {Function} callback xxxHonza: there should be support for a standard callback.
     * @return The method returns a promise that is resolved when the restoration process
     * is fully completed.
     */
    restoreState: function(toggles)
    {
        return this.restoreStateInternal(toggles, null, 0);
    },

    /**
     * Internal implementation used for recursion. Note that the restoration process
     * is composed from two asynchronous tasks.
     * 1) Fetch data from the server (e.g. over RDP protocol). This process doesn't have to
     * be always asynchronous, it depends on the actual data provider.
     * 2) Populate the UI. Must be done asynchronously, so big amount of data doesn't freeze
     * the UI. This also doesn't have to be always asynchronous. The first piece of items
     * is populated synchronously (so, if there is no more items it's done).
     *
     * These tasks are done for every branch that is expanded as part of the restoration
     * process. 'restoreState' is executed recursively for every tree-branch that is expanded.
     */
    restoreStateInternal: function(toggles, member, level)
    {
        if (Trace.active)
        {
            Trace.sysout("domBaseTree.restoreState; level: " + level, {
                member: member,
                toggles: toggles ? toggles.clone() : null,
            });
        }

        level = level || 0;

        // Don't try to expand children if there are no expanded items.
        if (!toggles || toggles.isEmpty())
        {
            Trace.sysout("domBaseTree.restoreState; No toggles in level: " + level);
            return Promise.resolve(level);
        }

        // Async restore handler for recursion (see the loop below).
        function onRestore(toggles, member, level, restored)
        {
            // As soon as the entire subtree is restored (data fetched from the server
            // and displayed in the UI, both asynchronous). Resolve the promise
            // passed in, to notify the parent task.
            this.restoreStateInternal(toggles, member, level).then(function()
            {
                Trace.sysout("domBaseTree.restoreState; level: " + level + " DONE", arguments);
                restored.resolve();
            })
        }

        // This is the return value promise. It's resolved when all (sub)children are resolved.
        // It allows the caller to wait till the tree (or subtree since 'restoreState'
        // is called recursively) is completely restored.
        var restoration = [];

        var rows = this.getChildRows(member, level);
        for (var i = 0; i < rows.length; i++)
        {
            var row = rows[i];
            var repObject = row.repObject;
            if (!repObject)
                continue;

            // Don't expand if the member doesn't have children any more.
            if (!repObject.hasChildren)
                continue;

            var name = this.getRowName(row);

            // Check if the current row-name should be expanded. It should if there is
            // an existing toggles entry for it.
            var newToggles = toggles.get(name);
            if (!newToggles)
                continue;

            toggles.remove(name);

            // Expand appropriate tree row.
            var promise = this.expandMember(repObject);

            // If no children are expanded bail out, we don't have to recursively
            // restore this node (child branch).
            if (newToggles.isEmpty())
            {
                Trace.sysout("domBaseTree.restoreState; no toggles level: " + level +
                    ", expand promise: " + promise);

                // OK, There are no toggles inside this object, but we still need to wait
                // at least till it's fully expanded.
                if (promise)
                    restoration.push(promise);

                continue;
            }

            // xxxHonza: Not sure when this happen.
            if (!promise)
            {
                TraceError.sysout("domBaseTree.restoreState; No promise!?");
                continue;
            }

            // Use another promise, so we can figure out when children in this sub-tree
            // are all completely restored (data fetched from the server and displayed in the UI).
            var restored = Promise.defer();
            restoration.push(restored.promise);

            // Bind the handler to the current arguments. They can change within the loop.
            // The handler will be executed as soon as members of the child level are fetched
            // from the server. The purpose of 'restoreChildren' is then to restore state of the
            // level.
            var restoreChildren = onRestore.bind(this, newToggles, repObject, level + 1, restored);
            promise.then(restoreChildren);
        }

        // The return value is a promise that is resolved as soon as all the
        // promises in the array are resolved - i.e. all the sub tree-nodes completely
        // fetched from the server and expanded.
        return Promise.all(restoration);
    },

    getChildRows: function(member, level)
    {
        var rows = [];

        var row = this.getMemberRow(member);
        if (!row && !level)
            row = this.element.firstChild.firstChild;

        if (!row)
            return rows;

        for (var firstRow = row.nextSibling; firstRow; firstRow = firstRow.nextSibling)
        {
            if (this.getRowLevel(firstRow) == level)
                rows.push(firstRow);
        }

        return rows;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    /**
     * Properly destroy the tree if it isn't needed anymore. The method ensures that any
     * ongoing asynchronous processes related to the tree (row expansion or presentation
     * state restoration) are properly canceled.
     *
     * xxxHonza: TODO implement + check all places where it should be called (Watch panel
     * and DOM panels)
     */
    destroy: function()
    {
        if (!this.deferreds)
            return;

        // xxxHonza: we need to make sure no timeouts are used and all deferred objects
        // are registered in the following array.
        // Reject all waiting deferred objects (promises).
        for (var i=0; i<this.deferreds.length; i++)
            this.deffereds[i].reject();
    },

    // xxxHonza: we might want to have a render() method.
    replace: function(parentNode, input)
    {
        // If any asynchronous processes are in progress (tree insertion or restoration),
        // they will be canceled. This is a big speedup when a tree is often refreshed
        // (e.g. during debugger stepping).
        this.destroy();

        // Render the passed input object.
        BaseTree.replace.apply(this, arguments);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Events

    onClick: function(event)
    {
        if (!Events.isLeftClick(event))
            return;

        var row = Dom.getAncestorByClass(event.target, "memberRow");
        var label = Dom.getAncestorByClass(event.target, "memberLabel");
        var valueCell = row.getElementsByClassName("memberValueCell").item(0);
        var target = row.lastChild.firstChild;
        var isString = Css.hasClass(target, "objectBox-string");
        var inValueCell = (event.target === valueCell || event.target === target);

        var repNode = Firebug.getRepNode(event.target);
        var memberRow = Css.hasClass(repNode, "memberRow");

        // Here, we are interested in the object associated with the value rep
        // (not the rep object associated with the row itself)
        var object = memberRow ? null : repNode.repObject;

        // Row member object created by the tree widget.
        var member = row.repObject;

        if (label && Css.hasClass(row, "hasChildren") && !(isString && inValueCell))
        {
            // Basic row toggling is implemented in {@DomTree}
            BaseTree.onClick.apply(this, arguments);
        }
        else
        {
            // 1) Click on functions navigates the user to the right source location
            // 2) Double click inverts boolean values and opens inline editor for others.
            if (typeof(object) == "function")
            {
                Firebug.chrome.select(object, "script");
                Events.cancelEvent(event);
            }
            else if (Events.isDoubleClick(event))
            {
                // The entire logic is part of the parent panel.
                var panel = Firebug.getElementPanel(row);
                if (!panel)
                    return;

                if (!member)
                {
                    TraceError.sysout("domBaseTree.onClick; ERROR No member associated!");
                    return;
                }

                // Only primitive types can be edited.
                // xxxHonza: this place requires the panel to have a provider property.
                // it also requires the panel to have setPropertyValue and editProperty,
                // which is all implemented by {@DomBasePanel}.
                // Shouldn't the logic be rather part of the DomBasePanel?
                var value = panel.provider.getValue(member.value);
                if (typeof(value) == "object")
                    return;

                // Read only values can't be edited.
                if (member.readOnly)
                    return;

                if (typeof(value) == "boolean")
                    panel.setPropertyValue(row, "" + !value);
                else
                    panel.editProperty(row);

                Events.cancelEvent(event);
            }
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Asynchronous Expanding/Collapsing

    toggleRow: function(row, forceOpen)
    {
        if (!row)
            return;

        var member = row.repObject;
        if (!member)
            return;

        var level = this.getRowLevel(row);
        if (forceOpen && Css.hasClass(row, "opened"))
            return;

        // Handle long strings. These don't have children, but can be shortened and
        // expanding them allows the user to see the entire string.
        var rowValue = this.getValue(member);
        var isString = typeof(rowValue) == "string";
        if (isString)
        {
            if (Css.hasClass(row, "opened"))
            {
                Css.removeClass(row, "opened");
                row.lastChild.firstChild.textContent = '"' + Str.cropMultipleLines(rowValue) + '"';
            }
            else
            {
                Css.setClass(row, "opened");
                row.lastChild.firstChild.textContent = '"' + rowValue + '"';
            }

            return;
        }

        // Overwrite the default child items expanding/collapsing and implement
        // asynchronous logic (so the UI doesn't freeze if there is huge amount
        // of items).
        if (Css.hasClass(row, "opened"))
        {
            Css.removeClass(row, "opened");

            this.collapseRowAsync(row);
        }
        else
        {
            // Do not expand if the member says there are no children.
            if (!member.hasChildren)
                return;

            Css.setClass(row, "opened");

            // Get children object for the next level.
            var members = this.getMembers(member.value, level + 1);
            var isPromise = DomTree.isPromise(members);

            Trace.sysout("DomBaseTree.toggleRow; level: " + (level + 1) + ", members: " +
                (members && members.length ? members.length : (isPromise ?
                "(promise)" : "null")) + ", ", members);

            // Insert rows if they are immediately available. Otherwise set a spinner
            // and wait for the update.
            if (members && members.length)
            {
                return this.expandRowAsync(row, members);
            }
            else if (isPromise)
            {
                Css.setClass(row, "spinning");
                return members;
            }
        }
    },

    expandRowAsync: function(row, members)
    {
        // xxxHonza: TODO
        // If we are still in the midst of inserting rows, cancel all pending
        // insertions here - this is a big speedup when stepping in the debugger
        /*if (this.timeouts)
        {
            for (var i = 0; i < this.timeouts.length; ++i)
                this.context.clearTimeout(this.timeouts[i]);
            delete this.timeouts;
        }*/

        var lastRow = row;
        var delay = 0;
        var setSize = members.length;
        var rowCount = 1;
        var deferred = Promise.defer();

        Trace.sysout("domBaseTree.expandRowAsync; members: " + setSize);

        function insertSlice(slice, isLast)
        {
            if (lastRow.parentNode)
            {
                var result = this.loop.insertRows({members: slice}, lastRow, this);
                lastRow = result[1];

                // xxxHonza: for a11y
                // Events.dispatch(DOMModule.fbListeners, "onMemberRowSliceAdded",
                //    [null, result, rowCount, setSize]);

                rowCount += insertSliceSize;

                Trace.sysout("domBaseTree.insertSlice; slice size: " + slice.length +
                    ", isLast: " + isLast);
            }

            if (isLast)
            {
                delete row.insertTimeout;
                deferred.resolve(lastRow);
            }
        };

        // First slice is inserted synchronously.
        var first = true;

        // xxxHonza: the logic should be improved
        // The while loop generates bunch if timeouts in advance and if the row is
        // collapsed before it's fully expanded they are not necessary. Members (slices)
        // should be appended step by step, so there is always just one timeout in the air.
        while (members.length)
        {
            var slice = members.splice(0, insertSliceSize);
            var isLast = !members.length;

            if (first)
            {
                insertSlice.call(this, slice, isLast);
            }
            else
            {
                // xxxHonza: it would be a bit safer to use context.setTimeout, so the
                // any active timeout is cleared if the page is suddenly refreshed.
                setTimeout(insertSlice.bind(this, slice, isLast), delay);
            }

            first = false;
            delay += insertInterval;
        }

        row.insertTimeout = delay;

        return deferred.promise;
    },

    collapseRowAsync: function(row)
    {
        var level = this.getRowLevel(row);
        var tbody = row.parentNode;
        var timeout = row.insertTimeout ? row.insertTimeout : 0;

        // xxxHonza: what if the row is expanded again before the timeouts are done?
        var self = this;
        setTimeout(function()
        {
            for (var firstRow = row.nextSibling; firstRow; firstRow = row.nextSibling)
            {
                if (self.getRowLevel(firstRow) <= level)
                    break;
                tbody.removeChild(firstRow);
            }
        }, timeout);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Path for persistence

    /**
     * Returns an array of parts that uniquely identifies a row (not always all JavaScript)
     * This is used for persistence of expanded nodes.
     */
    getPath: function(row)
    {
        var name = this.getRowName(row);
        var path = [name];

        var level = this.getRowLevel(row) - 1;
        for (row = row.previousSibling; row && level >= 0; row = row.previousSibling)
        {
            if (this.getRowLevel(row) === level)
            {
                name = this.getRowName(row);
                path.splice(0, 0, name);

                --level;
            }
        }

        return path;
    },

    getRowName: function(row)
    {
        var member = row.repObject;
        if (!member)
            return "";

        var name = this.provider.getId(member.value);
        if (!name)
            name = member.name;

        return name;
    }
});

// ********************************************************************************************* //
// Registration

return DomBaseTree;

// ********************************************************************************************* //
});

