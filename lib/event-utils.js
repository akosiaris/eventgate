'use strict';

const _        = require('lodash');
const P        = require('bluebird');
const yaml     = require('js-yaml');
const readFile = P.promisify(require('fs').readFile);
const preq     = require('preq');
const basename = require('path').basename;
const url      = require('url');

/**
 * This file contains simple utility functions.
 * TODO: should these functions just go in util.js?
 *       might make things simpler.
 */


/**
 * Converts a utf-8 byte buffer or a YAML/JSON string into
 * an object and returns it.
 * @param {string|Buffer|Object} data
 */
function objectFactory(data) {
    // if we are given a a JS object, return it now.
    if (_.isObject(data)) {
        return data;
    }

    // If we are given a byte Buffer, parse it as utf-8
    if (data instanceof Buffer) {
        data = data.toString('utf-8');
    }

    // If we now have a string, then assume it is a YAML/JSON string.
    if (_.isString(data)) {
        data = yaml.safeLoad(data);
    } else {
        throw new Error(
            'Could not convert data into an object.  ' +
            'Data must be a utf-8 byte buffer or a YAML/JSON string'
        );
    }

    return data;
}

/**
 * Thrown by the objectProperty function.
 */
class PropertyNotFoundError extends Error {}

/**
 * Given an object and a dotted path string, extracts
 * the value in the object at path.  Example:
 *
 * object = {prop1: 'yes', prop2: { sub1: { my_value: 'got me' } } };
 * path   = 'prop2.sub1.myvalue'
 * objectProperty(object, path)
 * // returns 'got me'
 *
 * This does not support objects that have dots in their property names, e.g.
 * { 'dotted.property.name': 'value' } cannot be extracted.
 * @param {string} path
 * @param {Object} object
 * @param {any} defaultValue
 * @throws PropertyNotFoundError if the path cannot be found in
 *         object and no defaultValue was given.
 */
function objectProperty(path, object, defaultValue) {
    if (_.isUndefined(path) || _.isUndefined(object)) {
        throw new Error(
            `Cannot get object property, either path (${path}) ` +
            `or object (${object}) are undefined.`
        );
    }

    return path.split('.').reduce((current, key) => {
        if (!_.has(current, key)) {
            if (defaultValue) {
                return defaultValue;
            } else {
                throw new PropertyNotFoundError(
                    `Property '${path}' not found in object`, object
                );
            }
        }
        return current[key];
    }, object);
}


/**
 * Given a URL, returns a Promise of the contents at that
 * URL.  Supports both file:// (via fs.readFile) and other http
 * based URLs with preq.get.
 * @param {string} u
 */
function urlGet(u) {
    if (_.isString(u)) {
        u = url.parse(u);
    }

    if (u.protocol === 'file:') {
        return readFile(u.pathname, 'utf-8');
    } else {
        return preq.get({ uri: u.href }).then(res => res.body);
    }
}

/**
 * Given a URL, returns a Promise of the contents at that
 * converted into an Object.  The content at URL
 * must either be a JSON or YAML string.
 * @param {string} url
 */
function urlGetObject(u) {
    return urlGet(u).then(content => objectFactory(content));
}

/**
 * Returns the file extension (or the last part after a final '.' in a file basename)
 * of a filename path.
 * @param {string} filename
 */
function fileExtension(filename) {
    if (!filename) {
        return '';
    }

    const parts = basename(filename).split('.');
    if (parts.length > 1) {
        return parts[parts.length - 1];
    } else {
        return '';
    }
}

/**
 * Given an event, extracts and returns a new URL
 * @param {string} uriField field path in event to extract URI
 * @param {string} baseUri If given, this will be prefixed to the extracted URI
 * @param {string} defaultFileExtension If the basename of the URI does not end
 *                 in a file extension, this will be appended to the URI.
 * @param {Object} event The event to extract a URL from.
 * @return {string} of the extracted URL
 */
function extractUrl(uriField, baseUri, defaultFileExtension, event) {
    let uri = objectProperty(uriField, event);

    // If schema uri doesn't already have an extension, and we are given a default one, append it.
    if (!fileExtension(uri) && defaultFileExtension) {
        uri += defaultFileExtension;
    }

    // Join uri with baseUri if given baseSchemaUri
    if (baseUri) {
        uri = baseUri + uri;
    }
    return url.parse(uri).href;
}


module.exports = {
    objectFactory,
    PropertyNotFoundError,
    objectProperty,
    urlGet,
    urlGetObject,
    fileExtension,
    extractUrl
};