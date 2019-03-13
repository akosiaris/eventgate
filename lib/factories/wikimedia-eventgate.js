'use strict';

const _ = require('lodash');
const P = require('bluebird');
const uuid = require('cassandra-uuid').TimeUuid;

const {
    uriHasProtocol,
    urlGetObject,
    uriGetFirstObject,
    objectGet,
    objectFindAndGet,
    stringMatches
} = require('../event-util');


const kafka = require('../kafka');
const EventValidator = require('../EventValidator');
const EventGate = require('../eventgate').EventGate;

// We'll use the makeExtractSchemaUri implementation that the
// default EventGate uses, but most of the Wikimedia specific produce
// related function implementations are custom and will be defined in this file.
const {
    makeExtractSchemaUri
} = require('../factories/default-eventgate');

const {
    PropertyNotFoundError,
    ValidationError
} = require('../error');


/**
 * This module can be used as the value of app.options.eventgate_factory_module.  It exports
 * a factory function that given options and a logger, returns an instantiated EventGate instance
 * that will produce to Kafka, and a mapToEventError function for transforming
 * errors into events that can be produced to an error topic.
 *
 * This file contains various functions for configuring and creating the main 'wikimedia'
 * EventGate instance using Express app.options.  These functions all use a options object
 * to make new functions that extract information from events (e.g. schema_uri_field)
 * and to create validate and produce functions for constructing the EventGate instance.
 *
 * This file uses the makeExtractSchemaUri exported by default-eventgate module, but
 * mostly creates and uses new Wikimedia specific functions.
 *
 * The Wikimedia validate function created will react to SIGHUPs by reloading
 * stream config and clearing any cached schemas and validators.
 *
 * The following keys are used in the options argument in functions here.
 *
 * - schema_uri_field
 *      The dotted object path to extract a schema_uri from an event.
 *      Default: $schema
 *
 * - schema_base_uri
 *      A base uri to prepend to values extracted from event schema_uri_fields
 *      Default: undefined
 *
 * - schema_file_extension
 *      A file extension to append to the extracted schema_uri_field if its
 *      URI doesn't already have one.
 *      Default: undefined
 *
 * - stream_field
 *      The dotted object path to the value to use for the topic/stream.
 *      If this is not given, the stream_uri_field will be used to construct
 *      a sanitized stream name.
 *      Default: undefined
 *
 * - topic_prefix
 *      If given, this will be prefixed to the value extracted from stream_field
 *      and used for the Kafka topic the event will be produced to.
 *      Default: undefined
 *
 * - id_field
 *      This field will be used as the event's 'id' in log messages
 *      Default: undefined
 *
 * - kafka.conf
 *      node-rdkafka KafkaProducer configuration
 *
 * - kafka.topic_conf
 *      node-rdkafka KafkaProducer topic configuration
 */


const defaultOptions = {
    schema_uri_field:       '$schema',
    schema_base_uri:        undefined,
    schema_file_extension:  undefined,
    stream_field:           undefined,
    topic_prefix:           undefined,
    id_field:               undefined,
    kafka: {
        conf: {
            'metadata.broker.list': 'localhost:9092'
        },
        topic_conf: {}
    },
};


/**
 * The schema URI of the error event that will be created and produced
 * for event validation errors.  Change this when you change
 * error schema versions.
 */
const errorSchemaUri = '/error/0.0.3';

/**
 * Returns a new mapToErrorEvent function that uses options.error_schema_uri
 * and options.error_stream to return an error event that conforms to the
 * error event schema used by Wikimedia.  This function only returns
 * error events for ValidationErrors.
 * @param {Object} options
 * @return {function(Object, Object, Object): Object}
 */
function makeMapToErrorEvent(options) {
    return (error, event, context = {}) => {
        // Only produce error events for ValidationErrors.
        if (!(error instanceof ValidationError)) {
            // Returning null will cause this particular error event
            // to not be produced at all.
            return null;
        }

        const now = new Date();

        const errorEvent = {
            meta: {
                id:         uuid.fromDate(now).toString(),
                dt:         now.toISOString(),
                uri:        _.get(event, 'meta.uri', 'unknown').toString(),
                domain:     _.get(event, 'meta.domain', 'unknown').toString(),
                request_id: _.get(event, 'meta.request_id', 'unknown').toString()
            },
            emitter_id: options.user_agent || 'eventgate-service',
            raw_event: _.isString(event) ? event : JSON.stringify(event),
            // We know error is an ValidationError,
            // so we can use errorsText as error message.
            message: error.errorsText
        };

        // Get the preferred schema_uri_field and stream_field
        // and set them on the event.
        /* eslint-disable */
        const schemaUriField =_.isArray(options.schema_uri_field) ?
            options.schema_uri_field[0] :
            options.schema_uri_field;
       const streamField = _.isArray(options.stream_field) ?
            options.stream_field[0] :
            options.stream_field;
        /* eslint-enable */

        _.set(errorEvent, schemaUriField, errorSchemaUri);
        _.set(errorEvent, streamField, options.error_stream);

        return errorEvent;
    };
}


class MissingStreamFieldError extends Error {}

/**
 * All wikimedia events should have stream_field set.  The function
 * created by this function returns the value extracted from event at stream_field.
 * @param {Object} options
 * @param {string} options.stream_field
 * @return {function(Object, Object): string}
 */
function makeExtractStream(options) {
    return (event, context = {}) => {
        try {
            return objectFindAndGet(event, options.stream_field);
        } catch (err) {
            // Wrap PropertyNotFoundError in a new specific Error about missing stream field.
            if (err instanceof PropertyNotFoundError) {
                throw new MissingStreamFieldError(
                    'Event stream name cannot be extracted. ' +
                    `Event must have a field named one of '${options.stream_field}'.`
                );
            } else {
                throw err;
            }
        }
    };
}


/**
 * Creates a function that returns a string representation of an event useful for logging.
 * @param {Object} options
 * @param {string} options.id_field
 *      Used to extract the event's 'id'.
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @param {string} options.stream_field
 *      Used to extract the event's destination stream name.
 * @return {function(Object, Object): string}
 */
function makeEventRepr(options) {
    // Use the already constructed functions if they are set in options, else
    // make them from options now.
    const extractSchemaUri = options.extractSchemaUri || makeExtractSchemaUri(options);
    const extractStream    = options.extractStream || makeExtractStream(options);

    return (event, context = {}) => {
        const eventId    = _.get(event, options.id_field);
        const schemaUri  = extractSchemaUri(event);
        const stream     = extractStream(event);

        /* eslint-disable */
        return 'event' +
            (eventId ? ` ${eventId}` : '') +
            (schemaUri ? ` of schema at ${schemaUri}` : '') +
            (stream ? ` destined to stream ${stream}` : '');
        /* eslint-enable */
    };
}

class UnauthorizedSchemaForStreamError extends Error {}

/**
 * Creates a new schema URI based validate(event) function.
 * The returned function first checks the stream config to ensure that
 * the event's schema title is allowed in the event's destination stream.
 * It then uses an EventValidator instance to validate
 * the event against its schema.
 * @param {Object} options
 * @param {string} options.stream_config_uri
 *      URI to a stream config file.  This file should contain
 *      a mapping of stream name to config, most importantly including
 *      the stream's allowed schema title.
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @param {string} options.schema_base_uri
 *      If set, this is prefixed to un-anchored schema URIs.
 * @param {string} options.schema_file_extension
 *      If set, this is suffixed to schema URIs that dont' already have a file extension.
 * @param {Object} logger
 * @return {EventGate~validate}
 */
async function makeWikimediaValidate(options, logger) {
    // A schema's title field will be compared to value of the stream config schema_title
    const schemaTitleField = 'title';
    const streamConfigSchemaTitleField = 'schema_title';

    // Use the already constructed functions if they are set in options, else
    // make them from options now.
    const extractSchemaUri = options.extractSchemaUri || makeExtractSchemaUri(options);
    const extractStream    = options.extractStream || makeExtractStream(options);
    const eventRepr        = options.eventRepr || makeEventRepr(options);
    let getSchema          = options.getSchema;


    if (!getSchema) {
        // First check if allow_absolute_schema_uris is false, and if it is, throw
        // an error if the event's uri starts with a protocol scheme.
        getSchema = (uri) => {
            // If we don't allow absolute schema URIs, then events shouldn't
            // ever have URIs that start with a URL protocol scheme.
            // If this one does, then throw and error and fail now.
            // (Protocol less URIs with domains are still assumed to be 'relative' by
            // resolveUri in event-utils, and will be prefixed with
            // schema_base_uris before they are searched.  So it is safe
            // to only check uriHasProtocol for URI absoluteness.)
            if (!options.allow_absolute_schema_uris && uriHasProtocol(uri)) {
                throw new Error(
                    `Absolute schema URIs are not allowed but event schema_uri is ${uri}`
                );
            }
            // Return the first schema found for URI by looking for it in each schema_base_uris.
            return uriGetFirstObject(uri, options.schema_base_uris, options.schema_file_extension);
        };
    }

    if (options.schema_base_uris) {
        logger.info(`Will look for relative schema_uris in ${options.schema_base_uris}`);
    }

    // These are not consts so that we can reload them on SIGHUP.
    let eventValidator;
    let streamConfig;
    let streamConfigKeys;

    /**
     * Initializes (and reloads) eventValidator and streamConfig.
     * This is a separate function so it can be called for initialization
     * as well as for a SIGHUP.
     */
    async function init() {
        // This EventValidator instance will be used to validate all incoming events.
        eventValidator = new EventValidator({
            extractSchemaUri,
            getSchema,
            log: logger
        });


        if (options.stream_config_uri) {
            // streamConfig contains mapping from stream names and/or
            // stream name regexes to stream config objects, including
            // allowed schema titles.
            logger.info(`Loading stream config from ${options.stream_config_uri}`);
            streamConfig = await urlGetObject(options.stream_config_uri);

            // Pre-compile any stream name regexes.
            streamConfigKeys = _.keys(streamConfig).map((key) => {
                // If this stream key looks like a regex, create a new RegExp.
                if (key.startsWith('/') && key.endsWith('/')) {
                    return new RegExp(key.substring(1, key.length - 1));
                }
                // else just return the key
                return key;
            });
        } else {
            logger.info(
                'No stream_config_uri was set; any $schema will be allowed in any stream.'
            );
        }

        if (options.schema_precache_uris) {
            P.map(options.schema_precache_uris, (uri) => {
                logger.info(`Precaching schema at ${uri}`);
                return eventValidator.validatorAt(uri);
            });
        }
    }

    await init();

    // On SIGHUP, reload eventValidator and streamConfig.
    process.on('SIGHUP', async() => {
        logger.info('Received SIGHUP, clearing cached schemas and reloading stream config.');
        await init();
        logger.debug('Finished clearing cached schemas and reloading stream config after SIGHUP.');
    });

    /**
     * Uses streamConfig to verify that the event is allowed in stream.
     * @param {Object} event
     * @param {string} stream
     * @throws {UnauthorizedSchemaForStreamError}
     * @return {boolean} true if the schema is allowed in stream.
     */
    async function ensureEventAllowedInStream(event, stream) {
        // Load the event's schema via eventValidator.
        // (This is cached inside of eventValidator's AJV instance.)
        const schema    = await eventValidator.schemaFor(event);
        // Get the schema URI for logging purposes.
        const schemaUri = extractSchemaUri(event);

        // Get the title field out of the schema.  This must match
        // the allowed schema for this stream.
        const schemaTitle = objectGet(schema, schemaTitleField);
        if (_.isUndefined(schemaTitle)) {
            throw new UnauthorizedSchemaForStreamError(
                `Schema at ${schemaUri} must define a 'title' field. From ${eventRepr(event)}`
            );
        }

        // Look up the stream config for this stream.
        // This will return the first matching stream config.
        const streamConfigKey = streamConfigKeys.find(key => stringMatches(stream, key));
        if (_.isUndefined(streamConfigKey)) {
            throw new UnauthorizedSchemaForStreamError(
                `${eventRepr(event)} is not allowed in stream; ` +
                `${stream} is not a configured stream.`
            );
        }

        const specificStreamConfig = _.get(streamConfig, streamConfigKey);
        const allowedSchemaTitle   = _.get(specificStreamConfig, streamConfigSchemaTitleField);

        if (_.isUndefined(allowedSchemaTitle)) {
            throw new UnauthorizedSchemaForStreamError(
                `${eventRepr(event)} is not allowed in stream; ` +
                `${stream} does not have a configured ${streamConfigSchemaTitleField}.`
            );
        }

        if (schemaTitle !== allowedSchemaTitle) {
            throw new UnauthorizedSchemaForStreamError(
                `${eventRepr(event)} is not allowed in stream; ` +
                `schema title must be ${allowedSchemaTitle}.`
            );
        }

        return true;
    }

    // Finally create a single validate function that
    // checks that an event's schema is allowed in a stream,
    // and that it validates against its schema.
    return async(event, context = {}) => {
        const stream = extractStream(event);

        if (options.stream_config_uri) {
            // First ensure that this event schema is allowed in the destination stream.
            await ensureEventAllowedInStream(event, stream);
        }
        // Then validate the event against its schema.
        return eventValidator.validate(event);
    };
}


/**
 * Creates a function that returns a Kafka produce function
 * suitable for passing to EventGate as the produce function argument.
 * This conditionally uses either a GuaranteedProducer or a HastyProducer
 * depending on the value of the context.req.query.hasty request query parameter.
 * @param {Object} options
 * @param {string} options.stream_field
 *      Used to extract the event's destination stream name.
 * @param {string} options.topic_prefix
 *      If given, this will be prefixed to the value extracted from stream_field
 *      and used as the topic in Kafka.
 * @param {KafkaProducer} guaranteedProducer
 *      Connected node-rdkafka Producer.
 * @param {KafkaProducer} hastyProducer
 *      Connected node-rdkafka Producer that sends events non guaranteed, aka hasty.
 *      This is optional, and will only be used if context.req.query.hasty is set to true.
 * @return {EventGate~produce} (event, context) => Promise<event>
 */
function makeProduce(options, guaranteedProducer, hastyProducer) {
    // Use the already constructed functions if they are set in options, else
    // make them from options now.
    const extractStream = options.extractStream || makeExtractStream(options);

    // Return a new function that takes a single event argument for produce.
    return (event, context = {}) => {
        const stream = extractStream(event);
        // If topic_prefix is configured, prefix the stream with it to get the topic.
        const topic = options.topic_prefix ? options.topic_prefix + stream : stream;
        const serializedEvent = Buffer.from(JSON.stringify(event));

        // Use hasty non-guaranteed producer if this event was submitted
        // using via HTTP with the ?hasty query parameter set to true.
        if (hastyProducer && _.get(context, 'req.query.hasty', false)) {
            return hastyProducer.produce(topic, undefined, serializedEvent, undefined);
        } else {
            return guaranteedProducer.produce(topic, undefined, serializedEvent, undefined);
        }
    };
}


/**
 * Returns a Promise of an instantiated EventGate that uses EventValidator
 * and event schema URL lookup and Kafka to produce messages.  error events
 * will be created and produced upon ValidationErrors.
 * @param {Object} options
 * @param {string} options.schema_uri_field
 *      Used to extract the event's schema URI.
 * @param {string} options.schema_base_uri
 *      If set, this is prefixed to un-anchored schema URIs.
 * @param {string} options.schema_file_extension
 *      If set, this is suffixed to schema URIs that dont' already have a file extension.
 * @param {string} options.id_field
 *      Used to extract the event's 'id'.
 * @param {string} options.stream_field
 *      Used to extract the event's destination stream name.
 * @param {string} options.topic_prefix
 *      If given, this will be prefixed to the value extracted from stream_field
 *      and used as the topic in Kafka.
 * @param {string} options.id_field
 *      This field will be used as the event's 'id' in log messages
 * @param {Object} options.kafka
 * @param {Object} options.kafka.options
 *      node-rdkafka KafkaProducer configuration
 * @param {Object} options.kafka.topic_options
 *      node-rdkafka KafkaProducer topic configuration
 * @param {Object} logger
 * @return {Promise<EventGate>}
 */
async function wikimediaEventGateFactory(options, logger) {
    _.defaults(options, defaultOptions);

    // Premake some of the event handling functions so that that they
    // can use each other without having to each make duplicate functions.
    // Each of the above make* functions will check options
    // to see if a function they would use is already set.
    options.extractSchemaUri = makeExtractSchemaUri(options);
    options.extractStream    = makeExtractStream(options);
    options.eventRepr        = makeEventRepr(options);

    const validate = await makeWikimediaValidate(options, logger);

    // Create both a GuaranteedProducer and a HastyProducer.
    // Which one is used during produce() is determined by the
    // req.query.hasty parameter.
    logger.info(`Connecting to Kafka brokers: ${options.kafka.conf['metadata.broker.list']}`);
    const guaranteedProducer = await kafka.GuaranteedProducer.factory(
        options.kafka.conf,
        options.kafka.topic_conf
    );
    const hastyProducer = await kafka.HastyProducer.factory(
        options.kafka.conf,
        options.kafka.topic_conf
    );

    const produce = makeProduce(options, guaranteedProducer, hastyProducer);

    return new EventGate({
        validate,
        produce,
        eventRepr: makeEventRepr(options),
        log: logger,
        mapToErrorEvent: makeMapToErrorEvent(options)
    });
}


module.exports = {
    factory: wikimediaEventGateFactory,
    makeMapToErrorEvent,
    makeEventRepr,
    makeExtractStream,
    makeWikimediaValidate,
    makeProduce,
    UnauthorizedSchemaForStreamError
};
