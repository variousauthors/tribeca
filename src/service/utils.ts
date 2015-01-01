/// <reference path="../../typings/tsd.d.ts" />

import Models = require("../common/models");
import momentjs = require('moment');
export var date = momentjs.utc;

import util = require("util");
import winston = require("winston");
winston.add(winston.transports.File, { filename: 'tribeca.log', timestamp: false, json: false });
export var log = (name : string) => {
    return (...msg : any[]) => {
        var head = util.format.bind(this, Models.toUtcFormattedTime(date()) + "\t[" + name + "]\t" + msg.shift());
        winston.info(head.apply(this, msg));
    };
};
export interface Logger { (...arg : any[]) : void;}

export class Evt<T> {
    constructor(private handlers : { (data? : T): void; }[] = []) {
        handlers.forEach(this.on);
    }

    public on(handler : (data? : T) => void) {
        this.handlers.push(handler);
    }

    public off(handler : (data? : T) => void) {
        this.handlers = this.handlers.filter(h => h !== handler);
    }

    public trigger(data? : T) {
        for (var i = 0; i < this.handlers.length; i++) {
            this.handlers[i](data);
        }
    }
}

export function roundFloat(x : number) {
    return Math.round(x * 100) / 100;
}