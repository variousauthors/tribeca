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

import crypto = require("crypto");
import querystring = require("querystring");
import request = require("request");
import moment = require("moment");
import log from "../logging";
import * as _ from "lodash";
import * as Q from "q";
var shortId = require("shortid");

/*
 * Interfaces.
 */
interface ChankuraPositionResponseItem {
    type: string;
    currency: string;
    amount: string;
    balance: string;
    locked: string;
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
// I implemented a bunch of the interfaces so that they fit the Chankura API.
// Note. I have id: string but on Chankura it say it's an integer. Will this cause issues?
interface ChankuraMarketLevel {
  price: string;
  volume: string;
  // timestamp: string; not sure what this coresponds to in the API
}
interface ChankuraOrderBook {
  bids: ChankuraMarketLevel[];
  asks: ChankuraMarketLevel[];
}
interface ChankuraNewOrderRequest {
  market: string; // Unique market id. e.g. 'btccny'.
  ord_type: string;
  price: string; // Price for each unit.
  side: string; // Either 'sell' or 'buy'.	
  volume: string; // The amount to sell/buy. 
}
interface ChankuraNewOrderResponse {
  id: string;
  message: string;
}
interface ChankuraDeleteOrderRequest {
  id: string;
}
interface ChankuraDeleteOrderResponse {
  message: string;
}
interface ChankuraOrderStatusRequest {
  id: string;
}
interface ChankuraOrderStatusResponse {
  id: string; // Unique order ID
  side: string; // Buy/Sell
  price: string; // The order price.
  avg_price: string; // The average execution price.
  state: string; // wait, done or cancel.
  market: string; // e.g. btczar
  created_at: string; // When the order was created.
  volume: string; // Initial Volume.
  remaining_volume: string; // Total remaining volume.
  executed_volume: string; // Total executed volume. 
  trades: ChankuraMarketTrade[]; // List of trades on this order.
}
interface ChankuraMarketTrade {
  id: string;
  price: string;
  volume: string;
  market: string;
  created_at: string;
  side: string;
}
interface ChankuraMyTradesResponse {
  id: string; // Unique ID e.g. 2
  price: string; // Trade price e.g. 3100
  volume: string; // Trade volume e.g. 10.2
  market: string; // The trade's market e.g. btczar
  created_at: string; // Trade time e.g. 2014-04-18T02:04:49Z"
  side: string; // e.g. sell
}
interface ChankuraMyTradesRequest {
  market: string; // e.g. btczar
  timestamp: number; // e.g. 121231241
}

/*
 * Helper Functions.
 */
const ConvertToMarketSide = (level: ChankuraMarketLevel): Models.MarketSide => {
  return new Models.MarketSide(parseFloat(level.price), parseFloat(level.volume));
}
const ConvertToMarketSides = (level: ChankuraMarketLevel[]): Models.MarketSide[] => {
  return _.map(level, ConvertToMarketSide);
}

// Two helpers for converting from string to Model.Sides.
const encodeSide = (side: Models.Side): string => {
  switch (side) {
    case Models.Side.Bid: return "buy";
    case Models.Side.Ask: return "sell";
    default: return "";
  }
}
const decodeSide = (side: string): Models.Side => {
  switch (side) {
    case "buy": return Models.Side.Bid;
    case "sell": return Models.Side.Ask;
    default: return Models.Side.Unknown;
  }
}

// TODO I'm not sure about this below. I just pulled from the Bitfinix gateway. 
// Need to replace with actual Time to enforce stuff.
const encodeTimeInForce = (tif: Models.TimeInForce, type: Models.OrderType): string => {
  if (type === Models.OrderType.Market) {
    return "exchange market";
  }
  else if (type === Models.OrderType.Limit) {
    if (tif === Models.TimeInForce.FOK)
      return "exchange fill-or-kill";
    if (tif === Models.TimeInForce.GTC)
      return "exchange limit";
  }
  throw new Error("unsupported tif " + Models.TimeInForce[tif] + " and order type " + Models.OrderType[type]);
}


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
  // and then triggers them, setting the this_since field to ensure we only poll
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

/* Draft implementation of the Order Gateway.*/
class ChankuraOrderEntryGateway implements Interfaces.IOrderEntryGateway {
  constructor(
    public timeProvider: Utils.ITimeProvider,
    private _details: ChankuraGatewayDetails,
    private _http: ChankuraHttp,
    private _symbolProvider: ChankuraSymbolProvider) {
      _http.ConnectChanged.on(s => this.ConnectChanged.trigger(s));
      timeProvider.setInterval(this.downloadOrderStatuses, moment.duration(8, "seconds"));
  }
  
  public OrderUpdate = new Utils.Evt<Models.OrderStatusUpdate>();
  public ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>(); 
  public cancelsByClientOrderId = false;
  public supportsCancelAllOpenOrders = () : boolean => { return false; };
  public cancelAllOpenOrders = () : Q.Promise<number> => { return Q(0); };
  public generateClientOrderId = () => shortId.generate();
  
  private _since = moment.utc();
  private _log = log("tribeca:gateway:ChankuraOE");
 
  public convertToOrderRequest = (order: Models.OrderStatusReport): ChankuraNewOrderRequest => {
    return {
      volume: order.quantity.toString(),
      price: order.price.toString(),
      side: encodeSide(order.side),
      market: this._symbolProvider.symbol,
      ord_type: encodeTimeInForce(order.timeInForce, order.type)
    };
  };

  public sendOrder = (order: Models.OrderStatusReport) => {
    var req = this.convertToOrderRequest(order);
    this._http
      .post<ChankuraNewOrderRequest, ChankuraNewOrderResponse>("POST", "orders.json", req)
      .then(resp => {
        if (typeof resp.data.message !== "undefined") {
          this.OrderUpdate.trigger({
            orderStatus: Models.OrderStatus.Rejected,
            orderId: order.orderId,
            rejectMessage: resp.data.message,
            time: resp.time
          });
        } else {
          this.OrderUpdate.trigger({
            orderStatus: Models.OrderStatus.Working,
            orderId: order.orderId,
            exchangeId: resp.data.id,
            time: resp.time
          });
        }
      }).done();
    this.OrderUpdate.trigger({
      orderId: order.orderId,
      computationalLatency: Utils.fastDiff(new Date(), order.time)
    });
  };
  
  public cancelOrder = (cancel: Models.OrderStatusReport) => {
    var req = { id: cancel.exchangeId };
    this._http
      .post<ChankuraDeleteOrderRequest, ChankuraDeleteOrderResponse>("POST", "order/delete.json", req)
      .then(resp => {
        if (typeof resp.data.message !== "undefined") {
          this.OrderUpdate.trigger({
            orderStatus: Models.OrderStatus.Rejected,
            cancelRejected: true,
            orderId: cancel.orderId,
            rejectMessage: resp.data.message,
            time: resp.time
          });
        } else {
          this.OrderUpdate.trigger({
            orderId: cancel.orderId,
            time: resp.time,
            orderStatus: Models.OrderStatus.Cancelled
          });
        }
      }).done();

    this.OrderUpdate.trigger({
      orderId: cancel.orderId,
      computationalLatency: Utils.fastDiff(new Date(), cancel.time)
    });
  };

  public replaceOrder = (replace: Models.OrderStatusReport) => {
    this.cancelOrder(replace);
    this.sendOrder(replace);
  };

  private downloadOrderStatuses = () => {
    var tradesReq = { timestamp: this._since.unix(), market: this._symbolProvider.symbol };
    this._http
      .post<ChankuraMyTradesRequest, ChankuraMyTradesResponse[]>("GET", "trades/my.json", tradesReq)
      .then(resps => {
        _.forEach(resps.data, trade => {
          this._http
            .post<ChankuraOrderStatusRequest, ChankuraOrderStatusResponse>("GET", "order.json", {id: trade.id})
            .then(r => {
              this.OrderUpdate.trigger({
                exchangeId: trade.id,
                lastPrice: parseFloat(trade.price),
                lastQuantity: parseFloat(trade.volume),
                orderStatus: ChankuraOrderEntryGateway._getOrderStatus(r.data),
                averagePrice: parseFloat(r.data.avg_price),
                leavesQuantity: parseFloat(r.data.remaining_volume),
                cumQuantity: parseFloat(r.data.executed_volume),
                quantity: parseFloat(r.data.volume)
              });
            }).done();
          });
        }).done();
    this._since = moment.utc();
  };

  private static _getOrderStatus(r: ChankuraOrderStatusResponse) {
    switch(r.state) {
      case 'wait': return Models.OrderStatus.Working;
      case 'cancel': return Models.OrderStatus.Cancelled;
      case 'done': return Models.OrderStatus.Complete;
      default: return Models.OrderStatus.Other;
    }
  };
};


class ChankuraHttp {
  ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>(); 
  private _timeout = 15000;
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
  };

  // Posts an authorized Request (type = TRequest) to Chankura and returns response at type TResponse
  public post = <TRequest, TResponse>(method: string, actionUrl: string, msg: TRequest): Q.Promise<Models.Timestamped<TResponse>> => {
    return this._postOnce<TRequest, TResponse>(method, actionUrl, _.clone(msg)).then(resp =>
      {
        var rejectMsg: string = (<any>(resp.data)).message;
        if (typeof rejectMsg !== "undefined" && rejectMsg.indexOf("Nonce is too small") > -1)
          return this.post<TRequest, TResponse>(method, actionUrl, _.clone(msg));
        else
          return resp;
      });
  };

  
  private _postOnce = <TRequest, TResponse>(method: string, actionUrl: string, msg: TRequest): Q.Promise<Models.Timestamped<TResponse>> => {
    var params = 'access_key=' + this._apiKey + '&tonce=' + this._nonce + '&';
    var query = querystring.stringify(msg);
    var payload = method + "|api/v2" + actionUrl + "|" + params + query;
    this._nonce += 1;
    var signature = crypto.createHmac("sha256", this._secret).update(payload).digest('hex');
    const url = this._baseUrl + "/" + actionUrl + '?' + params + query + '&signature' + signature;
    var opts = {
      timeout: this._timeout,
      url: url,
      method: method
    };
    return this.doRequest<TResponse>(opts, url);
  };
   
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
}

class ChankuraPositionGateway implements Interfaces.IPositionGateway {
  PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();
  private onRefreshPositions = () => {
    let query = {};
    this._http.post<{}, ChankuraPositionResponseItem[]>( "GET" ,"/members/me.json", {}).then(res => {
      console.log(res.data['accounts']);
      _.forEach(res.data['accounts'], p => {
        var amt = parseFloat(p.balance);
        var cur = Models.toCurrency(p.currency);
        var held = parseFloat(p.locked);
        var rpt = new Models.CurrencyPosition(amt, held, cur);
        this.PositionUpdate.trigger(rpt);
      });
    }).done();
  }

  private _log = log("tribeca:gateway:ChankuraPG");
  constructor(timeProvider: Utils.ITimeProvider, private _http: ChankuraHttp) {
    timeProvider.setInterval(this.onRefreshPositions, moment.duration(15, "seconds"));
    this.onRefreshPositions();
  }
}

class ChankuraGatewayDetails implements Interfaces.IExchangeDetailsGateway {
  public get hasSelfTradePrevention() {
    return false;
  }
  name(): string {
    return "Chankura";
  }
  // No Maker and taker fees on Chankura !.
  makeFee(): number {
    return 0.000;
  }
  takeFee(): number {
    return 0.000;
  }
  exchange(): Models.Exchange {
    return Models.Exchange.Chankura;
  }
  constructor(public minTickIncrement: number) { }
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
    const orderGateway = config.GetString("ChankuraOrderDestination") == "Chankura"
        ? <Interfaces.IOrderEntryGateway>new ChankuraOrderEntryGateway(timeProvider, details, http, symbol)
        : new NullGateway.NullOrderGateway();
      
    super(
      new ChankuraMarketDataGateway(timeProvider, http, symbol),
      orderGateway,
      new ChankuraPositionGateway(timeProvider, http),
      details)
  }
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
