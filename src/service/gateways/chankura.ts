/// <reference path="../utils.ts" />
/// <reference path="../../common/models.ts" />
///<reference path="../interfaces.ts"/>
///<reference path="../config.ts"/>
/// <reference path="nullgw.ts" />

import Interfaces = require("../interfaces");
import Utils = require("../utils");
import Config = require("../config");
import Models = require("../../common/models");
import NullGateway = require("./nullgw");

import request = require("request");
import moment = require("moment");
import log from "../logging";
import * as _ from "lodash";
import * as Q from "q";

// TODO we have a problem. Most of the market pairs returned by Chankura's /markets api
// are not among those that tribeca recognizes
// checkout the implementation of CurrencyPair for a list of supported currencies
// at the minimum we will need to add all the missing currencies to that enum
// Also, like... does this bot only trade one pair at a time? - (Yes this is true.)
class ChankuraSymbolProvider {
  public symbol: string;

  // HEY! this pair comes from the environment config variable TradedPair, go check out /env
  // Nice. Now this maps directly to the currency ids (like credoeth) simply by taking the lower case
    // and concatenating like you had. 
    // TODO not all of them exist however. Could use a check.
  constructor(pair: Models.CurrencyPair) {
    this.symbol =  Models.fromCurrency(pair.base).toLowerCase() + Models.fromCurrency(pair.quote).toLowerCase();
  }
}
interface ChankuraMarketLevel {
  price: string;
  volume: string;
  // timestamp: string; not sure what this coresponds to in the API
}

interface ChankuraOrderBook {
  bids: ChankuraMarketLevel[];
  asks: ChankuraMarketLevel[];
}

const ConvertToMarketSide = (level: ChankuraMarketLevel): Models.MarketSide => {
  return new Models.MarketSide(parseFloat(level.price), parseFloat(level.volume));
}

const ConvertToMarketSides = (level: ChankuraMarketLevel[]): Models.MarketSide[] => {
  return _.map(level, ConvertToMarketSide);
}

// This decodes the side field when constructing Model.GatewarMarketTrades.
function decodeSide(side) {
    switch (side) {
        case "buy": return Models.Side.Bid;
        case "sell": return Models.Side.Ask;
        default: return Models.Side.Unknown;
    }
}

// This interface holds the ChankuraMarketTrade data pulled during a GET trades request.
interface ChankuraMarketTrade {
  id: number;
  price: string;
  volume: string;
  funds: string;
  market: string;
  created_at: string;
  side: string;
}


// This is the only thing we've implemented, and only half way
// it pulls down a list of orders from /order_book
export class ChankuraMarketDataGateway implements Interfaces.IMarketDataGateway {
  MarketData = new Utils.Evt<Models.Market>();
  ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
  MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();
  private _since: number = null;
  
  constructor(
    timeProvider: Utils.ITimeProvider,
    private _http: ChankuraHttp,
    private _symbolProvider: ChankuraSymbolProvider) {

    timeProvider.setInterval(this.downloadMarketData, moment.duration(5, "seconds"));
    timeProvider.setInterval(this.downloadMarketTrades, moment.duration(15, "seconds"));

    this.downloadMarketData();
    this.downloadMarketTrades();

    _http.ConnectChanged.on(s => this.ConnectChanged.trigger(s));
  }

  // Parses an array of ChankuraMarketTrade items into Models.GatewayMarketTrade
  // and then triggers them, setting the this_since field. To ensure we only poll
  // the latest trades.
  private onTrades = (trades: Models.Timestamped<ChankuraMarketTrade[]>) => {
     _.forEach(trades.data, trade => {
        var px = parseFloat(trade.price);
        var sz = parseFloat(trade.volume);
        var time = moment(trade.created_at).toDate();
        var side = decodeSide(trade.side);
        var mt = new Models.GatewayMarketTrade(px, sz, time, this._since === null, side);
        this.MarketTrade.trigger(mt);
    });
    this._since = moment().unix();
  }
  
  // This calls a http get request for Chankura Trades passing in the this_since param to get only trades 
  // that have occured since.
  private downloadMarketTrades = () => {
      // We pull the trades from -60 seconds before the last. This is probably overkill. They get filtered
      // using their uuid.
      var qs = { market: this._symbolProvider.symbol, 
                 timestamp: this._since === null ? moment.utc().subtract(60, "seconds").unix() : this._since };

      // Get request which parses the json response into a ChankuraMarketTrade array.
      this._http
          .get<ChankuraMarketTrade[]>("trades.json", qs)
          .then(this.onTrades)
          .done();
  };
  
  private onMarketData = (book: Models.Timestamped<ChankuraOrderBook>) => {
    var bids = ConvertToMarketSides(book.data.bids);
    var asks = ConvertToMarketSides(book.data.asks);
    this.MarketData.trigger(new Models.Market(bids, asks, book.time));
  };

  private downloadMarketData = () => {
    this._http
      .get<ChankuraOrderBook>(
        "order_book.json", { 
          market: this._symbolProvider.symbol, 
          bids_limit: 5, 
          asks_limit: 5,
        })
      .then(this.onMarketData)
      .done();
  };
}

class ChankuraGatewayDetails implements Interfaces.IExchangeDetailsGateway {
  public get hasSelfTradePrevention() {
    return false;
  }

  name(): string {
    return "Chankura";
  }

  makeFee(): number {
    return 0.001;
  }

  takeFee(): number {
    return 0.002;
  }

  exchange(): Models.Exchange {
    return Models.Exchange.Null;
    // return Models.Exchange.Chankura;
  }

  constructor(public minTickIncrement: number) { }
}

class ChankuraHttp {
  ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

  private _timeout = 15000;

  get = <T>(actionUrl: string, qs?: any): Q.Promise<Models.Timestamped<T>> => {
    const url = this._baseUrl + "/" + actionUrl;
    var opts = {
      timeout: this._timeout,
      url: url,
      qs: qs || undefined,
      method: "GET"
    };

    return this.doRequest<T>(opts, url);
  };

  private doRequest = <TResponse>(msg: request.Options, url: string): Q.Promise<Models.Timestamped<TResponse>> => {
    var d = Q.defer<Models.Timestamped<TResponse>>();

    // should monitor the rate limit ;)
    // this._monitor.add();

    request(msg, (err, resp, body) => {
      if (err) {
        this._log.error(err, "Error returned: url=", url, "err=", err);
        d.reject(err);
      }
      else {
        try {
          var t = new Date();
          var data = JSON.parse(body);
          d.resolve(new Models.Timestamped(data, t));
        }
        catch (err) {
          this._log.error(err, "Error parsing JSON url=", url, "err=", err, ", body=", body);
          d.reject(err);
        }
      }
    });

    return d.promise;
  };

  private _log = log("tribeca:gateway:ChankuraHTTP");
  private _baseUrl: string;
  private _apiKey: string;
  private _secret: string;
  private _nonce: number;

  constructor(config: Config.IConfigProvider /*, private _monitor: RateLimitMonitor */) {
    this._baseUrl = config.GetString("ChankuraHttpUrl")
    this._apiKey = config.GetString("ChankuraKey");
    this._secret = config.GetString("ChankuraSecret");

    this._nonce = new Date().valueOf();
    this._log.info("Starting nonce: ", this._nonce);
    setTimeout(() => this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected), 10);
  }
}

class Chankura extends Interfaces.CombinedGateway {
  constructor(
    timeProvider: Utils.ITimeProvider,
    config: Config.IConfigProvider,
    symbol: ChankuraSymbolProvider,
    pricePrecision: number,
    pair: Models.CurrencyPair,
  ) {
    // const monitor = new RateLimitMonitor(60, moment.duration(1, "minutes"));
    const http = new ChankuraHttp(config, /* monitor */);
    const details = new ChankuraGatewayDetails(pricePrecision);

    /*
    const orderGateway = config.GetString("BitfinexOrderDestination") == "Bitfinex"
        ? <Interfaces.IOrderEntryGateway>new BitfinexOrderEntryGateway(timeProvider, details, http, symbol)
        : new NullGateway.NullOrderGateway();
    */

    const orderGateway = new NullGateway.NullOrderGateway();

    const minTick = config.GetNumber("NullGatewayTick");

    super(
      new ChankuraMarketDataGateway(timeProvider, http, symbol),
      orderGateway,
      new NullGateway.NullPositionGateway(pair),
      details)
  }
}

// not sure what symbol_details corresponds to in Chankura
// it is "products" in coinbase and "symbols" in hitbtc...
// for now I'm using the id field for the market code eg btcusd
interface SymbolDetails {
    id: string,
    pair: string,
    price_precision: number,
    initial_margin:string,
    minimum_margin:string,
    maximum_order_size:string,
    minimum_order_size:string,
    expiration:string
}

export async function createChankura(timeProvider: Utils.ITimeProvider, config: Config.IConfigProvider, pair: Models.CurrencyPair): Promise<Interfaces.CombinedGateway> {
  const detailsUrl = config.GetString("ChankuraHttpUrl") + "/markets";
  const symbolDetails = await Utils.getJSON<SymbolDetails[]>(detailsUrl);
  const symbol = new ChankuraSymbolProvider(pair);

  for (let s of symbolDetails) {
    if (s.id === symbol.symbol)
      return new Chankura(timeProvider, config, symbol, 10 ** (-1 * s.price_precision), pair);
  }

  throw new Error("cannot match pair to a Chankura Symbol " + pair.toString());
}
